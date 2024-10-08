import {
    ClinicalDataEnrichmentWithQ,
    ComparisonGroup,
    EnrichmentAnalysisComparisonGroup,
    getGroupsDownloadData,
    getNumSamples,
    getOverlapComputations,
    getSampleIdentifiers,
    getStudyIds,
    IOverlapComputations,
    isGroupEmpty,
    partitionCasesByGroupMembership,
} from '../../../pages/groupComparison/GroupComparisonUtils';
import { GroupComparisonTab } from '../../../pages/groupComparison/GroupComparisonTabs';
import {
    findFirstMostCommonElt,
    MobxPromise,
    onMobxPromise,
    remoteData,
    stringListToMap,
    toPromise,
} from 'cbioportal-frontend-commons';
import {
    AlterationFilter,
    CancerStudy,
    ClinicalAttribute,
    ClinicalData,
    ClinicalDataMultiStudyFilter,
    ClinicalEventData,
    Group,
    MolecularProfile,
    MolecularProfileCasesGroupFilter,
    MolecularProfileFilter,
    ReferenceGenomeGene,
    Sample,
    SurvivalRequest,
} from 'cbioportal-ts-api-client';
import {
    action,
    autorun,
    computed,
    IReactionDisposer,
    makeObservable,
    observable,
    reaction,
    toJS,
} from 'mobx';
import client from '../../api/cbioportalClientInstance';
import comparisonClient from '../../api/comparisonGroupClientInstance';
import _ from 'lodash';
import {
    compareByAlterationPercentage,
    getAlterationRowData,
    pickAllGenericAssayEnrichmentProfiles,
    pickCopyNumberEnrichmentProfiles,
    pickGenericAssayBinaryEnrichmentProfiles,
    pickGenericAssayCategoricalEnrichmentProfiles,
    pickGenericAssayEnrichmentProfiles,
    pickMethylationEnrichmentProfiles,
    pickMRNAEnrichmentProfiles,
    pickMutationEnrichmentProfiles,
    pickProteinEnrichmentProfiles,
    pickStructuralVariantEnrichmentProfiles,
} from '../../../pages/resultsView/enrichments/EnrichmentsUtil';
import {
    makeEnrichmentDataPromise,
    makeGenericAssayEnrichmentDataPromise,
    makeGenericAssayBinaryEnrichmentDataPromise,
    makeGenericAssayCategoricalEnrichmentDataPromise,
} from '../../../pages/resultsView/ResultsViewPageStoreUtils';
import internalClient from '../../api/cbioportalInternalClientInstance';
import autobind from 'autobind-decorator';
import { PatientSurvival } from 'shared/model/PatientSurvival';
import { getPatientSurvivals } from 'pages/resultsView/SurvivalStoreHelper';
import {
    getFilteredMolecularProfilesByAlterationType,
    getPatientIdentifiers,
    buildSelectedDriverTiersMap,
    showQueryUpdatedToast,
} from 'pages/studyView/StudyViewUtils';
import { calculateQValues } from 'shared/lib/calculation/BenjaminiHochbergFDRCalculator';
import ComplexKeyMap from '../complexKeyDataStructures/ComplexKeyMap';
import ComplexKeyGroupsMap from '../complexKeyDataStructures/ComplexKeyGroupsMap';
import { AppStore } from '../../../AppStore';
import { ISurvivalDescription } from 'pages/resultsView/survival/SurvivalDescriptionTable';
import {
    fetchAllReferenceGenomeGenes,
    fetchSurvivalDataExists,
    getSurvivalClinicalAttributesPrefix,
} from 'shared/lib/StoreUtils';
import { ResultsViewPageStore } from '../../../pages/resultsView/ResultsViewPageStore';
import { AlterationTypeConstants, DataTypeConstants } from 'shared/constants';
import {
    generateSurvivalPlotTitleFromDisplayName,
    getSurvivalStatusBoolean,
} from 'pages/resultsView/survival/SurvivalUtil';
import {
    cnaEventTypeSelectInit,
    CopyNumberEnrichmentEventType,
    CustomSurvivalPlots,
    EnrichmentEventType,
    getCopyNumberEventTypesAPIParameter,
    getMutationEventTypesAPIParameter,
    getSurvivalPlotName,
    getSurvivalPlotDescription,
    MutationEnrichmentEventType,
    mutationEventTypeSelectInit,
    StructuralVariantEnrichmentEventType,
} from 'shared/lib/comparison/ComparisonStoreUtils';
import {
    buildDriverAnnotationSettings,
    IAnnotationFilterSettings,
    IDriverAnnotationReport,
    initializeCustomDriverAnnotationSettings,
} from 'shared/alterationFiltering/AnnotationFilteringSettings';
import { getServerConfig } from 'config/config';
import IComparisonURLWrapper from 'pages/groupComparison/IComparisonURLWrapper';
import {
    ComparisonSession,
    SessionGroupData,
} from 'shared/api/session-service/sessionServiceModels';
import { AlterationEnrichmentRow } from 'shared/model/AlterationEnrichmentRow';
import AnalysisStore from './AnalysisStore';
import { AnnotatedMutation } from 'shared/model/AnnotatedMutation';
import { compileMutations } from './AnalysisStoreUtils';
import { SurvivalChartType } from 'pages/resultsView/survival/SurvivalPrefixTable';

export enum OverlapStrategy {
    INCLUDE = 'Include',
    EXCLUDE = 'Exclude',
}

export type ClinicalEventDataWithKey = ClinicalEventData & { label: string };

export default abstract class ComparisonStore extends AnalysisStore
    implements IAnnotationFilterSettings {
    private tabHasBeenShown = observable.map<GroupComparisonTab, boolean>();

    private reactionDisposers: IReactionDisposer[] = [];
    @observable public newSessionPending = false;

    @observable includeGermlineMutations = true;
    @observable includeSomaticMutations = true;
    @observable includeUnknownStatusMutations = true;

    @observable public adjustForLeftTruncation = true;

    @observable selectedSurvivalPlotPrefix: string | undefined = undefined;

    public customSurvivalDataPromises: {
        [id: string]: MobxPromise<ClinicalData[]>;
    } = {};

    constructor(
        protected appStore: AppStore,
        protected urlWrapper: IComparisonURLWrapper,
        protected resultsViewStore?: ResultsViewPageStore
    ) {
        super();
        makeObservable(this);

        this.driverAnnotationSettings = buildDriverAnnotationSettings(
            () => false
        );

        (window as any).compStore = this;

        setTimeout(() => {
            // When groups in the comparison are updated by the user
            // certain tabs that were visible before might no longer be
            // supported by the data and would be hidden. Disappearing
            // tabs without explanation is considered bad UX design.
            // The logic below keeps track of tabs that were shown before
            // and keeps them visible between group updates.
            this.reactionDisposers.push(
                autorun(() => {
                    this.tabHasBeenShown.set(
                        GroupComparisonTab.SURVIVAL,
                        !!this.tabHasBeenShown.get(
                            GroupComparisonTab.SURVIVAL
                        ) || this.showSurvivalTab
                    );
                    this.tabHasBeenShown.set(
                        GroupComparisonTab.MRNA,
                        !!this.tabHasBeenShown.get(GroupComparisonTab.MRNA) ||
                            this.showMRNATab
                    );
                    this.tabHasBeenShown.set(
                        GroupComparisonTab.PROTEIN,
                        !!this.tabHasBeenShown.get(
                            GroupComparisonTab.PROTEIN
                        ) || this.showProteinTab
                    );
                    this.tabHasBeenShown.set(
                        GroupComparisonTab.DNAMETHYLATION,
                        !!this.tabHasBeenShown.get(
                            GroupComparisonTab.DNAMETHYLATION
                        ) || this.showMethylationTab
                    );
                    this.tabHasBeenShown.set(
                        GroupComparisonTab.GENERIC_ASSAY_PREFIX,
                        !!this.tabHasBeenShown.get(
                            GroupComparisonTab.GENERIC_ASSAY_PREFIX
                        ) || this.showGenericAssayTab
                    );
                    this.tabHasBeenShown.set(
                        GroupComparisonTab.GENERIC_ASSAY_BINARY_PREFIX,
                        !!this.tabHasBeenShown.get(
                            GroupComparisonTab.GENERIC_ASSAY_BINARY_PREFIX
                        ) || this.showGenericAssayBinaryTab
                    );
                    this.tabHasBeenShown.set(
                        GroupComparisonTab.ALTERATIONS,
                        !!this.tabHasBeenShown.get(
                            GroupComparisonTab.ALTERATIONS
                        ) || this.showAlterationsTab
                    );
                    this.tabHasBeenShown.set(
                        GroupComparisonTab.MUTATIONS,
                        !!this.tabHasBeenShown.get(
                            GroupComparisonTab.MUTATIONS
                        ) || this.showMutationsTab
                    );
                })
            );

            this.reactionDisposers.push(
                reaction(
                    () => this.isSessionLoaded,
                    isComplete => {
                        if (isComplete) {
                            this.loadCustomSurvivalCharts();
                        }
                    }
                )
            );
        }); // do this after timeout so that all subclasses have time to construct
    }

    public destroy(): void {
        for (const disposer of this.reactionDisposers) {
            disposer();
        }
    }

    @observable
    public startEventPosition: 'FIRST' | 'LAST' = 'FIRST';

    @observable
    public endEventPosition: 'FIRST' | 'LAST' = 'FIRST';

    @observable
    public censoredEventPosition: 'FIRST' | 'LAST' = 'LAST';

    @observable
    public _selectedStartClinicalEventType: string | undefined = undefined;

    @observable
    public selectedStartClinicalEventAttributes: ClinicalEventDataWithKey[] = [];

    @observable
    public _selectedEndClinicalEventType: string | undefined = undefined;

    @observable
    public selectedEndClinicalEventAttributes: ClinicalEventDataWithKey[] = [];

    @observable
    public _selectedCensoredClinicalEventType: string | undefined = 'any';

    @observable.ref chartName: string;

    @observable
    public selectedCensoredClinicalEventAttributes: ClinicalEventDataWithKey[] = [];

    @action.bound
    public setSurvivalPlotPrefix(prefix: string | undefined) {
        this.selectedSurvivalPlotPrefix = prefix;
    }

    @action.bound
    public onStartClinicalEventSelection(option: any) {
        if (option !== null) {
            this._selectedStartClinicalEventType = option.value;
            this.selectedStartClinicalEventAttributes = [];
        } else {
            this._selectedStartClinicalEventType = undefined;
        }
    }

    @computed get selectedStartClinicalEventType() {
        if (this._selectedStartClinicalEventType !== undefined) {
            return this.clinicalEventOptions.result[
                this._selectedStartClinicalEventType
            ];
        }
        return undefined;
    }

    @action.bound
    public onEndClinicalEventSelection(option: any) {
        if (option !== null) {
            this._selectedEndClinicalEventType = option.value;
            this.selectedEndClinicalEventAttributes = [];
        } else {
            this._selectedEndClinicalEventType = undefined;
        }
    }

    @computed get selectedEndClinicalEventType() {
        if (this._selectedEndClinicalEventType !== undefined) {
            return this.clinicalEventOptions.result[
                this._selectedEndClinicalEventType
            ];
        }
        return undefined;
    }

    @action.bound
    public onCensoredClinicalEventSelection(option: any) {
        if (option !== null) {
            this._selectedCensoredClinicalEventType = option.value;
            this.selectedCensoredClinicalEventAttributes = [];
        } else {
            this._selectedCensoredClinicalEventType = 'any';
        }
    }

    @action.bound
    public onKMPlotNameChange(e: React.SyntheticEvent<HTMLInputElement>) {
        this.chartName = (e.target as HTMLInputElement).value;
    }

    @action.bound
    public resetSurvivalPlotSelection() {
        this.chartName = '';
        this._selectedStartClinicalEventType = undefined;
        this.startEventPosition = 'FIRST';
        this.selectedStartClinicalEventAttributes = [];
        this._selectedEndClinicalEventType = undefined;
        this.endEventPosition = 'FIRST';
        this.selectedEndClinicalEventAttributes = [];
        this._selectedCensoredClinicalEventType = 'any';
        this.censoredEventPosition = 'LAST';
        this.selectedCensoredClinicalEventAttributes = [];
    }

    @action.bound
    public async onAddSurvivalPlot() {
        let chartName =
            this.chartName !== undefined && this.chartName.length > 0
                ? this.chartName
                : getSurvivalPlotName(
                      this._selectedStartClinicalEventType!,
                      this.selectedStartClinicalEventAttributes || [],
                      this.startEventPosition,
                      this._selectedEndClinicalEventType!,
                      this.selectedEndClinicalEventAttributes || [],
                      this.endEventPosition,
                      this._selectedCensoredClinicalEventType!,
                      this.selectedCensoredClinicalEventAttributes || [],
                      _.values(this.survivalTitleByPrefix.result || {})
                  );

        this.addSurvivalRequest(
            this._selectedStartClinicalEventType!,
            this.startEventPosition,
            this.selectedStartClinicalEventAttributes,
            this._selectedEndClinicalEventType!,
            this.endEventPosition,
            this.selectedEndClinicalEventAttributes,
            this._selectedCensoredClinicalEventType!,
            this.censoredEventPosition,
            this.selectedCensoredClinicalEventAttributes,
            chartName
        );

        await toPromise(this.customSurvivalDataPromises[chartName]);
        showQueryUpdatedToast(`Successfully added survival plot: ${chartName}`);

        this.setSurvivalPlotPrefix(chartName);
        this.updateCustomSurvivalPlots(this.customSurvivalPlots);
        this.chartName = '';
    }

    @computed get selectedCensoredClinicalEventType() {
        if (this._selectedCensoredClinicalEventType !== undefined) {
            if (this._selectedCensoredClinicalEventType === 'any') {
                return {
                    label: 'any event',
                    value: 'any',
                    attributes: [],
                } as any;
            }
            return this.clinicalEventOptions.result[
                this._selectedCensoredClinicalEventType
            ];
        }
        return undefined;
    }

    @computed get doesChartNameAlreadyExists() {
        return (
            this.chartName !== undefined &&
            this.chartName.length >= 0 &&
            _.values(this.survivalTitleByPrefix.result || {}).some(
                prefix =>
                    prefix.toLowerCase().trim() ===
                    this.chartName.toLowerCase().trim()
            )
        );
    }

    readonly survivalTitleByPrefix = remoteData(
        {
            await: () => [
                this.survivalClinicalAttributesPrefix,
                this.survivalDescriptions,
            ],
            invoke: () =>
                Promise.resolve(
                    this.survivalClinicalAttributesPrefix.result!.reduce(
                        (map, prefix) => {
                            // get survival plot titles
                            // use first display name as title
                            map[
                                prefix
                            ] = generateSurvivalPlotTitleFromDisplayName(
                                this.survivalDescriptions.result![prefix][0]
                                    .displayName
                            );
                            return map;
                        },
                        {} as { [prefix: string]: string }
                    )
                ),
        },
        {}
    );

    @computed get isAddSurvivalPlotDisabled() {
        return (
            this._selectedStartClinicalEventType === undefined ||
            this._selectedEndClinicalEventType === undefined ||
            this.doesChartNameAlreadyExists ||
            this.patientSurvivals.isPending
        );
    }

    @computed get selectedCopyNumberEnrichmentEventTypes() {
        if (this.urlWrapper.selectedEnrichmentEventTypes) {
            return stringListToMap(
                this.urlWrapper.selectedEnrichmentEventTypes.filter(
                    // get copy number enrichment types
                    t => t in CopyNumberEnrichmentEventType
                ),
                t => true
            );
        } else {
            // default
            return cnaEventTypeSelectInit(
                this.alterationEnrichmentProfiles.result
                    ?.copyNumberEnrichmentProfiles || []
            );
        }
    }

    @computed get selectedMutationEnrichmentEventTypes() {
        if (this.urlWrapper.selectedEnrichmentEventTypes) {
            return stringListToMap(
                this.urlWrapper.selectedEnrichmentEventTypes.filter(
                    // get mutation enrichment types
                    t => t in MutationEnrichmentEventType
                ),
                t => true
            );
        } else {
            // default
            return mutationEventTypeSelectInit(
                this.alterationEnrichmentProfiles.result?.mutationProfiles || []
            );
        }
    }

    @computed get isStructuralVariantEnrichmentSelected() {
        if (this.urlWrapper.selectedEnrichmentEventTypes) {
            return this.urlWrapper.selectedEnrichmentEventTypes.includes(
                StructuralVariantEnrichmentEventType.structural_variant
            );
        }
        return !!(
            this.alterationEnrichmentProfiles.result &&
            this.alterationEnrichmentProfiles.result.structuralVariantProfiles
                .length > 0
        );
    }

    @autobind
    public updateSelectedEnrichmentEventTypes(t: EnrichmentEventType[]) {
        this.urlWrapper.updateSelectedEnrichmentEventTypes(t);
    }

    // < To be implemented in subclasses: >
    public isGroupSelected(name: string): boolean {
        throw new Error('isGroupSelected must be implemented in subclass');
    }
    public setUsePatientLevelEnrichments(s: boolean) {
        throw new Error(
            'setUsePatientLevelEnrichments must be implemented in subclass'
        );
    }
    public toggleGroupSelected(groupName: string) {
        throw new Error(`toggleGroupSelected must be implemented in subclass`);
    }
    public updateGroupOrder(oldIndex: number, newIndex: number) {
        throw new Error(`updateGroupOrder must be implemented in subclass`);
    }
    public selectAllGroups() {
        throw new Error(`selectAllGroups must be implemented in subclass`);
    }
    public deselectAllGroups() {
        throw new Error(`deselectAllGroups must be implemented in subclass`);
    }
    protected async saveAndGoToSession(newSession: ComparisonSession) {
        throw new Error(`saveAndGoToSession must be implemented in subclass`);
    }
    abstract get _session(): MobxPromise<ComparisonSession>;
    abstract _originalGroups: MobxPromise<ComparisonGroup[]>;
    abstract get overlapStrategy(): OverlapStrategy;
    abstract get usePatientLevelEnrichments(): boolean;
    // < / >

    @computed public get isLoggedIn() {
        return this.appStore.isLoggedIn;
    }

    @computed get isSessionLoaded() {
        return this._session.isComplete;
    }

    public async addGroup(group: SessionGroupData, saveToUser: boolean) {
        this.newSessionPending = true;
        if (saveToUser && this.isLoggedIn) {
            await comparisonClient.addGroup(group);
        }
        const newSession = _.cloneDeep(this._session.result!);
        newSession.groups.push(group);

        this.saveAndGoToSession(newSession);
    }

    public async deleteGroup(name: string) {
        this.newSessionPending = true;
        const newSession = _.cloneDeep(this._session.result!);
        newSession.groups = newSession.groups.filter(g => g.name !== name);

        this.saveAndGoToSession(newSession);
    }

    public async updateCustomSurvivalPlots(
        customSurvivalPlots: CustomSurvivalPlots
    ) {
        const newSession = toJS(this._session.result!);
        newSession.customSurvivalPlots = _.values(customSurvivalPlots) as any;

        // Need this to prevent page for reloading
        localStorage.setItem('preventPageReload', 'true');

        await this.saveAndGoToSession(newSession);
    }

    readonly origin = remoteData({
        // the studies that the comparison groups come from
        await: () => [this._session],
        invoke: () => Promise.resolve(this._session.result!.origin),
    });

    readonly existingGroupNames = remoteData({
        await: () => [this._originalGroups, this.origin],
        invoke: async () => {
            const ret = {
                session: this._originalGroups.result!.map(g => g.name),
                user: [] as string[],
            };
            if (this.isLoggedIn) {
                // need to add all groups belonging to this user for this origin
                ret.user = (
                    await comparisonClient.getGroupsForStudies(
                        this.origin.result!
                    )
                ).map(g => g.data.name);
            }
            return ret;
        },
    });

    readonly overlapComputations = remoteData<
        IOverlapComputations<ComparisonGroup>
    >({
        await: () => [this._originalGroups],
        invoke: () => {
            return Promise.resolve(
                getOverlapComputations(
                    this._originalGroups.result!,
                    this.isGroupSelected
                )
            );
        },
    });

    readonly availableGroups = remoteData<ComparisonGroup[]>({
        await: () => [this._originalGroups, this._originalGroupsOverlapRemoved],
        invoke: () => {
            let ret: ComparisonGroup[];
            switch (this.overlapStrategy) {
                case OverlapStrategy.INCLUDE:
                    ret = this._originalGroups.result!;
                    break;
                case OverlapStrategy.EXCLUDE:
                default:
                    ret = this._originalGroupsOverlapRemoved.result!;
                    break;
            }
            return Promise.resolve(ret);
        },
    });

    readonly activeGroups = remoteData<ComparisonGroup[]>({
        await: () => [this.availableGroups],
        invoke: () =>
            Promise.resolve(
                this.availableGroups.result!.filter(
                    group =>
                        this.isGroupSelected(group.name) && !isGroupEmpty(group)
                )
            ),
    });

    readonly enrichmentAnalysisGroups = remoteData({
        await: () => [this.activeGroups, this.sampleMap],
        invoke: () => {
            const sampleSet =
                this.sampleMap.result || new ComplexKeyMap<Sample>();
            const groups = this.activeGroups.result!.map(group => {
                const samples: Sample[] = [];
                group.studies.forEach(studyEntry => {
                    const studyId = studyEntry.id;
                    studyEntry.samples.forEach(sampleId => {
                        if (sampleSet.has({ studyId: studyId, sampleId })) {
                            const sample = sampleSet.get({
                                studyId: studyId,
                                sampleId,
                            })!;
                            samples.push(sample);
                        }
                    });
                });
                return {
                    name: group.nameWithOrdinal,
                    description: '',
                    count: getNumSamples(group),
                    color: group.color,
                    samples,
                    nameOfEnrichmentDirection: group.nameOfEnrichmentDirection,
                };
            });
            return Promise.resolve(groups);
        },
    });

    readonly _originalGroupsOverlapRemoved = remoteData<ComparisonGroup[]>({
        await: () => [this.overlapComputations, this._originalGroups],
        invoke: () => Promise.resolve(this.overlapComputations.result!.groups),
    });

    readonly _activeGroupsOverlapRemoved = remoteData<ComparisonGroup[]>({
        await: () => [this._originalGroupsOverlapRemoved],
        invoke: () =>
            Promise.resolve(
                this._originalGroupsOverlapRemoved.result!.filter(
                    group =>
                        this.isGroupSelected(group.name) && !isGroupEmpty(group)
                )
            ),
    });

    readonly _activeGroupsNotOverlapRemoved = remoteData({
        await: () => [this._originalGroups, this.overlapComputations],
        invoke: () => {
            let excludedGroups = this.overlapComputations.result!
                .excludedFromAnalysis;
            if (this.overlapStrategy === OverlapStrategy.INCLUDE) {
                excludedGroups = {};
            }
            return Promise.resolve(
                this._originalGroups.result!.filter(
                    group =>
                        this.isGroupSelected(group.name) &&
                        !(group.uid in excludedGroups)
                )
            );
        },
    });

    readonly _selectedGroups = remoteData({
        await: () => [this._originalGroups],
        invoke: () =>
            Promise.resolve(
                this._originalGroups.result!.filter(group =>
                    this.isGroupSelected(group.name)
                )
            ),
    });

    readonly activeSamplesNotOverlapRemoved = remoteData({
        await: () => [this.sampleMap, this._activeGroupsNotOverlapRemoved],
        invoke: () => {
            const activeSampleIdentifiers = getSampleIdentifiers(
                this._activeGroupsNotOverlapRemoved.result!
            );
            const sampleSet = this.sampleMap.result!;
            return Promise.resolve(
                activeSampleIdentifiers.map(
                    sampleIdentifier => sampleSet.get(sampleIdentifier)!
                )
            );
        },
    });

    readonly activePatientKeysNotOverlapRemoved = remoteData({
        await: () => [this.activeSamplesNotOverlapRemoved],
        invoke: () =>
            Promise.resolve(
                _.uniq(
                    this.activeSamplesNotOverlapRemoved.result!.map(
                        s => s.uniquePatientKey
                    )
                )
            ),
    });

    readonly activeStudyIds = remoteData({
        await: () => [this.activeGroups],
        invoke: () => Promise.resolve(getStudyIds(this.activeGroups.result!)),
    });

    readonly molecularProfilesInActiveStudies = remoteData<MolecularProfile[]>(
        {
            await: () => [this.activeStudyIds, this.molecularProfilesInStudies],
            invoke: async () => {
                return _.filter(this.molecularProfilesInStudies.result!, s =>
                    this.activeStudyIds.result!.includes(s.studyId)
                );
            },
        },
        []
    );

    readonly referenceGenes = remoteData<ReferenceGenomeGene[]>({
        await: () => [this.studies],
        invoke: () => {
            if (this.studies.result!.length > 0) {
                return fetchAllReferenceGenomeGenes(
                    this.studies.result![0].referenceGenome
                );
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly hugoGeneSymbolToReferenceGene = remoteData<{
        [hugoSymbol: string]: ReferenceGenomeGene;
    }>({
        await: () => [this.referenceGenes],
        invoke: () => {
            // build reference gene map
            return Promise.resolve(
                _.keyBy(this.referenceGenes.result!, g => g.hugoGeneSymbol)
            );
        },
    });

    public readonly alterationEnrichmentProfiles = remoteData({
        await: () => [this.molecularProfilesInActiveStudies],
        invoke: () => {
            return Promise.resolve({
                mutationProfiles: pickMutationEnrichmentProfiles(
                    this.molecularProfilesInActiveStudies.result!
                ),
                structuralVariantProfiles: pickStructuralVariantEnrichmentProfiles(
                    this.molecularProfilesInActiveStudies.result!
                ),
                copyNumberEnrichmentProfiles: pickCopyNumberEnrichmentProfiles(
                    this.molecularProfilesInActiveStudies.result!
                ),
            });
        },
    });

    public readonly mutationEnrichmentProfiles = remoteData({
        await: () => [this.alterationEnrichmentProfiles],
        invoke: () =>
            Promise.resolve(
                this.alterationEnrichmentProfiles.result!.mutationProfiles
            ),
    });
    //
    public readonly structuralVariantProfiles = remoteData({
        await: () => [this.alterationEnrichmentProfiles],
        invoke: () =>
            Promise.resolve(
                this.alterationEnrichmentProfiles.result!
                    .structuralVariantProfiles
            ),
    });

    public readonly structuralVariantEnrichmentProfiles = remoteData({
        await: () => [this.molecularProfilesInActiveStudies],
        invoke: () =>
            Promise.resolve(
                pickStructuralVariantEnrichmentProfiles(
                    this.molecularProfilesInActiveStudies.result!
                )
            ),
    });

    public readonly copyNumberEnrichmentProfiles = remoteData({
        await: () => [this.alterationEnrichmentProfiles],
        invoke: () =>
            Promise.resolve(
                this.alterationEnrichmentProfiles.result!
                    .copyNumberEnrichmentProfiles
            ),
    });

    public readonly mRNAEnrichmentProfiles = remoteData({
        await: () => [this.molecularProfilesInActiveStudies],
        invoke: () =>
            Promise.resolve(
                pickMRNAEnrichmentProfiles(
                    this.molecularProfilesInActiveStudies.result!
                )
            ),
    });

    public readonly proteinEnrichmentProfiles = remoteData({
        await: () => [this.molecularProfilesInActiveStudies],
        invoke: () =>
            Promise.resolve(
                pickProteinEnrichmentProfiles(
                    this.molecularProfilesInActiveStudies.result!
                )
            ),
    });

    public readonly methylationEnrichmentProfiles = remoteData({
        await: () => [this.molecularProfilesInActiveStudies],
        invoke: () =>
            Promise.resolve(
                pickMethylationEnrichmentProfiles(
                    this.molecularProfilesInActiveStudies.result!
                )
            ),
    });

    public readonly genericAssayAllEnrichmentProfilesGroupedByGenericAssayType = remoteData(
        {
            await: () => [this.molecularProfilesInActiveStudies],
            invoke: () => {
                const availableProfiles = this.molecularProfilesInActiveStudies
                    .result!;
                return Promise.resolve(
                    _.groupBy(
                        pickAllGenericAssayEnrichmentProfiles(
                            availableProfiles
                        ),
                        profile => profile.genericAssayType
                    )
                );
            },
        }
    );
    public readonly genericAssayEnrichmentProfilesGroupedByGenericAssayType = remoteData(
        {
            await: () => [this.molecularProfilesInActiveStudies],
            invoke: () =>
                Promise.resolve(
                    _.groupBy(
                        pickGenericAssayEnrichmentProfiles(
                            this.molecularProfilesInActiveStudies.result!
                        ),
                        profile => profile.genericAssayType
                    )
                ),
        }
    );

    public readonly genericAssayBinaryEnrichmentProfilesGroupedByGenericAssayType = remoteData(
        {
            await: () => [this.molecularProfilesInActiveStudies],
            invoke: () =>
                Promise.resolve(
                    _.groupBy(
                        pickGenericAssayBinaryEnrichmentProfiles(
                            this.molecularProfilesInActiveStudies.result!
                        ),
                        profile => profile.genericAssayType
                    )
                ),
        }
    );

    public readonly genericAssayCategoricalEnrichmentProfilesGroupedByGenericAssayType = remoteData(
        {
            await: () => [this.molecularProfilesInActiveStudies],
            invoke: () =>
                Promise.resolve(
                    _.groupBy(
                        pickGenericAssayCategoricalEnrichmentProfiles(
                            this.molecularProfilesInActiveStudies.result!
                        ),
                        profile => profile.genericAssayType
                    )
                ),
        }
    );

    @observable.ref private _mutationEnrichmentProfileMap: {
        [studyId: string]: MolecularProfile;
    } = {};
    @observable.ref private _structuralVariantEnrichmentProfileMap: {
        [studyId: string]: MolecularProfile;
    } = {};
    @observable.ref private _copyNumberEnrichmentProfileMap: {
        [studyId: string]: MolecularProfile;
    } = {};
    @observable.ref private _mRNAEnrichmentProfileMap: {
        [studyId: string]: MolecularProfile;
    } = {};
    @observable.ref private _proteinEnrichmentProfileMap: {
        [studyId: string]: MolecularProfile;
    } = {};
    @observable.ref private _methylationEnrichmentProfileMap: {
        [studyId: string]: MolecularProfile;
    } = {};
    @observable.ref
    private _selectedAllGenericAssayEnrichmentProfileMapGroupedByGenericAssayType: {
        [geneircAssayType: string]: {
            [studyId: string]: MolecularProfile;
        };
    } = {};
    @observable.ref
    private _selectedGenericAssayEnrichmentProfileMapGroupedByGenericAssayType: {
        [geneircAssayType: string]: {
            [studyId: string]: MolecularProfile;
        };
    } = {};
    @observable.ref
    private _selectedGenericAssayBinaryEnrichmentProfileMapGroupedByGenericAssayType: {
        [geneircAssayType: string]: {
            [studyId: string]: MolecularProfile;
        };
    } = {};
    @observable.ref
    private _selectedGenericAssayCategoricalEnrichmentProfileMapGroupedByGenericAssayType: {
        [geneircAssayType: string]: {
            [studyId: string]: MolecularProfile;
        };
    } = {};

    @observable customSurvivalPlots: CustomSurvivalPlots = {};

    @observable customClinicalAttributes: ClinicalAttribute[] = [];

    readonly selectedStudyMutationEnrichmentProfileMap = remoteData<{
        [studyId: string]: MolecularProfile;
    }>({
        await: () => [this.mutationEnrichmentProfiles],
        invoke: () => {
            //Only return Mutation profile if any mutation type is selected, otherwise return {}
            if (
                _(this.selectedMutationEnrichmentEventTypes)
                    .values()
                    .some()
            ) {
                // set default enrichmentProfileMap if not selected yet
                if (_.isEmpty(this._mutationEnrichmentProfileMap)) {
                    const molecularProfilesbyStudyId = _.groupBy(
                        this.mutationEnrichmentProfiles.result!,
                        profile => profile.studyId
                    );
                    // Select only one molecular profile for each study
                    return Promise.resolve(
                        _.mapValues(
                            molecularProfilesbyStudyId,
                            molecularProfiles => molecularProfiles[0]
                        )
                    );
                } else {
                    return Promise.resolve(this._mutationEnrichmentProfileMap);
                }
            } else {
                return Promise.resolve({});
            }
        },
    });

    readonly selectedStudyStructuralVariantEnrichmentProfileMap = remoteData<{
        [studyId: string]: MolecularProfile;
    }>({
        await: () => [this.structuralVariantEnrichmentProfiles],
        invoke: () => {
            // set default enrichmentProfileMap if not selected yet
            if (this.isStructuralVariantEnrichmentSelected) {
                if (_.isEmpty(this._structuralVariantEnrichmentProfileMap)) {
                    const structuralVariantProfiles = getFilteredMolecularProfilesByAlterationType(
                        _.groupBy(
                            this.structuralVariantEnrichmentProfiles.result!,
                            profile => profile.studyId
                        ),
                        AlterationTypeConstants.STRUCTURAL_VARIANT,
                        [DataTypeConstants.FUSION, DataTypeConstants.SV]
                    );

                    return Promise.resolve(
                        _.keyBy(
                            structuralVariantProfiles,
                            profile => profile.studyId
                        )
                    );
                } else {
                    return Promise.resolve(
                        this._structuralVariantEnrichmentProfileMap
                    );
                }
            } else {
                return Promise.resolve({});
            }
        },
    });

    readonly selectedStudyCopyNumberEnrichmentProfileMap = remoteData<{
        [studyId: string]: MolecularProfile;
    }>({
        await: () => [this.copyNumberEnrichmentProfiles],
        invoke: () => {
            //Only return Copy Number profile if any copy number type is selected, otherwise return {}
            if (
                _(this.selectedCopyNumberEnrichmentEventTypes)
                    .values()
                    .some()
            ) {
                // set default enrichmentProfileMap if not selected yet
                if (_.isEmpty(this._copyNumberEnrichmentProfileMap)) {
                    const molecularProfilesbyStudyId = _.groupBy(
                        this.copyNumberEnrichmentProfiles.result!,
                        profile => profile.studyId
                    );
                    // Select only one molecular profile for each study
                    return Promise.resolve(
                        _.mapValues(
                            molecularProfilesbyStudyId,
                            molecularProfiles => molecularProfiles[0]
                        )
                    );
                } else {
                    return Promise.resolve(
                        this._copyNumberEnrichmentProfileMap
                    );
                }
            } else {
                return Promise.resolve({});
            }
        },
    });

    readonly selectedmRNAEnrichmentProfileMap = remoteData({
        await: () => [this.mRNAEnrichmentProfiles],
        invoke: () => {
            // set default enrichmentProfileMap if not selected yet
            if (_.isEmpty(this._mRNAEnrichmentProfileMap)) {
                const molecularProfilesbyStudyId = _.groupBy(
                    this.mRNAEnrichmentProfiles.result!,
                    profile => profile.studyId
                );
                // Select only one molecular profile for each study
                return Promise.resolve(
                    _.mapValues(
                        molecularProfilesbyStudyId,
                        molecularProfiles => molecularProfiles[0]
                    )
                );
            } else {
                return Promise.resolve(this._mRNAEnrichmentProfileMap);
            }
        },
    });

    readonly selectedProteinEnrichmentProfileMap = remoteData({
        await: () => [this.proteinEnrichmentProfiles],
        invoke: () => {
            // set default enrichmentProfileMap if not selected yet
            if (_.isEmpty(this._proteinEnrichmentProfileMap)) {
                const molecularProfilesbyStudyId = _.groupBy(
                    this.proteinEnrichmentProfiles.result!,
                    profile => profile.studyId
                );
                // Select only one molecular profile for each study
                return Promise.resolve(
                    _.mapValues(
                        molecularProfilesbyStudyId,
                        molecularProfiles => molecularProfiles[0]
                    )
                );
            } else {
                return Promise.resolve(this._proteinEnrichmentProfileMap);
            }
        },
    });

    readonly selectedMethylationEnrichmentProfileMap = remoteData({
        await: () => [this.methylationEnrichmentProfiles],
        invoke: () => {
            // set default enrichmentProfileMap if not selected yet
            if (_.isEmpty(this._methylationEnrichmentProfileMap)) {
                const molecularProfilesbyStudyId = _.groupBy(
                    this.methylationEnrichmentProfiles.result!,
                    profile => profile.studyId
                );
                // Select only one molecular profile for each study
                return Promise.resolve(
                    _.mapValues(
                        molecularProfilesbyStudyId,
                        molecularProfiles => molecularProfiles[0]
                    )
                );
            } else {
                return Promise.resolve(this._methylationEnrichmentProfileMap);
            }
        },
    });
    readonly selectedAllGenericAssayEnrichmentProfileMapGroupedByGenericAssayType = remoteData(
        {
            await: () => [
                this.genericAssayAllEnrichmentProfilesGroupedByGenericAssayType,
            ],
            invoke: () => {
                if (
                    _.isEmpty(
                        this
                            ._selectedAllGenericAssayEnrichmentProfileMapGroupedByGenericAssayType
                    )
                ) {
                    return Promise.resolve(
                        _.mapValues(
                            this
                                .genericAssayAllEnrichmentProfilesGroupedByGenericAssayType
                                .result!,
                            genericAssayEnrichmentProfiles => {
                                const molecularProfilesbyStudyId = _.groupBy(
                                    genericAssayEnrichmentProfiles,
                                    profile => profile.studyId
                                );
                                // Select only one molecular profile for each study
                                return _.mapValues(
                                    molecularProfilesbyStudyId,
                                    molecularProfiles => molecularProfiles[0]
                                );
                            }
                        )
                    );
                } else {
                    return Promise.resolve(
                        this
                            ._selectedAllGenericAssayEnrichmentProfileMapGroupedByGenericAssayType
                    );
                }
            },
        }
    );
    readonly selectedGenericAssayEnrichmentProfileMapGroupedByGenericAssayType = remoteData(
        {
            await: () => [
                this.genericAssayEnrichmentProfilesGroupedByGenericAssayType,
            ],
            invoke: () => {
                if (
                    _.isEmpty(
                        this
                            ._selectedGenericAssayEnrichmentProfileMapGroupedByGenericAssayType
                    )
                ) {
                    return Promise.resolve(
                        _.mapValues(
                            this
                                .genericAssayEnrichmentProfilesGroupedByGenericAssayType
                                .result!,
                            genericAssayEnrichmentProfiles => {
                                const molecularProfilesbyStudyId = _.groupBy(
                                    genericAssayEnrichmentProfiles,
                                    profile => profile.studyId
                                );
                                // Select only one molecular profile for each study
                                return _.mapValues(
                                    molecularProfilesbyStudyId,
                                    molecularProfiles => molecularProfiles[0]
                                );
                            }
                        )
                    );
                } else {
                    return Promise.resolve(
                        this
                            ._selectedGenericAssayEnrichmentProfileMapGroupedByGenericAssayType
                    );
                }
            },
        }
    );

    readonly selectedGenericAssayBinaryEnrichmentProfileMapGroupedByGenericAssayType = remoteData(
        {
            await: () => [
                this
                    .genericAssayBinaryEnrichmentProfilesGroupedByGenericAssayType,
            ],
            invoke: () => {
                if (
                    _.isEmpty(
                        this
                            ._selectedGenericAssayBinaryEnrichmentProfileMapGroupedByGenericAssayType
                    )
                ) {
                    return Promise.resolve(
                        _.mapValues(
                            this
                                .genericAssayBinaryEnrichmentProfilesGroupedByGenericAssayType
                                .result!,
                            genericAssayEnrichmentProfiles => {
                                const molecularProfilesbyStudyId = _.groupBy(
                                    genericAssayEnrichmentProfiles,
                                    profile => profile.studyId
                                );
                                // Select only one molecular profile for each study
                                return _.mapValues(
                                    molecularProfilesbyStudyId,
                                    molecularProfiles => molecularProfiles[0]
                                );
                            }
                        )
                    );
                } else {
                    return Promise.resolve(
                        this
                            ._selectedGenericAssayBinaryEnrichmentProfileMapGroupedByGenericAssayType
                    );
                }
            },
        }
    );

    readonly selectedGenericAssayCategoricalEnrichmentProfileMapGroupedByGenericAssayType = remoteData(
        {
            await: () => [
                this
                    .genericAssayCategoricalEnrichmentProfilesGroupedByGenericAssayType,
            ],
            invoke: () => {
                if (
                    _.isEmpty(
                        this
                            ._selectedGenericAssayCategoricalEnrichmentProfileMapGroupedByGenericAssayType
                    )
                ) {
                    return Promise.resolve(
                        _.mapValues(
                            this
                                .genericAssayCategoricalEnrichmentProfilesGroupedByGenericAssayType
                                .result!,
                            genericAssayEnrichmentProfiles => {
                                const molecularProfilesbyStudyId = _.groupBy(
                                    genericAssayEnrichmentProfiles,
                                    profile => profile.studyId
                                );
                                // Select only one molecular profile for each study
                                return _.mapValues(
                                    molecularProfilesbyStudyId,
                                    molecularProfiles => molecularProfiles[0]
                                );
                            }
                        )
                    );
                } else {
                    return Promise.resolve(
                        this
                            ._selectedGenericAssayCategoricalEnrichmentProfileMapGroupedByGenericAssayType
                    );
                }
            },
        }
    );
    @action
    public setMutationEnrichmentProfileMap(profileMap: {
        [studyId: string]: MolecularProfile;
    }) {
        this._mutationEnrichmentProfileMap = profileMap;
    }

    @action
    public setStructuralVariantEnrichmentProfileMap(profileMap: {
        [studyId: string]: MolecularProfile;
    }) {
        this._structuralVariantEnrichmentProfileMap = profileMap;
    }

    @action
    public setCopyNumberEnrichmentProfileMap(profileMap: {
        [studyId: string]: MolecularProfile;
    }) {
        this._copyNumberEnrichmentProfileMap = profileMap;
    }

    @action
    public setMRNAEnrichmentProfileMap(profiles: {
        [studyId: string]: MolecularProfile;
    }) {
        this._mRNAEnrichmentProfileMap = profiles;
    }

    @action
    public setProteinEnrichmentProfileMap(profileMap: {
        [studyId: string]: MolecularProfile;
    }) {
        this._proteinEnrichmentProfileMap = profileMap;
    }

    @action
    public setMethylationEnrichmentProfileMap(profileMap: {
        [studyId: string]: MolecularProfile;
    }) {
        this._methylationEnrichmentProfileMap = profileMap;
    }

    @action
    public setAllGenericAssayEnrichmentProfileMap(
        profileMap: {
            [studyId: string]: MolecularProfile;
        },
        genericAssayType: string
    ) {
        const clonedMap = _.clone(
            this
                .selectedAllGenericAssayEnrichmentProfileMapGroupedByGenericAssayType
                .result!
        );
        clonedMap[genericAssayType] = profileMap;
        // trigger the function to recompute
        this._selectedAllGenericAssayEnrichmentProfileMapGroupedByGenericAssayType = clonedMap;
    }

    @action
    public setGenericAssayEnrichmentProfileMap(
        profileMap: {
            [studyId: string]: MolecularProfile;
        },
        genericAssayType: string
    ) {
        const clonedMap = _.clone(
            this
                .selectedGenericAssayEnrichmentProfileMapGroupedByGenericAssayType
                .result!
        );
        clonedMap[genericAssayType] = profileMap;
        // trigger the function to recompute
        this._selectedGenericAssayEnrichmentProfileMapGroupedByGenericAssayType = clonedMap;
    }

    @action.bound
    public removeCustomSurvivalPlot(prefix: string) {
        if (!_.isEmpty(this.customSurvivalPlots)) {
            delete this.customSurvivalPlots[prefix];
            delete this.customSurvivalDataPromises[prefix];
            this.updateCustomSurvivalPlots(toJS(this.customSurvivalPlots));
        }
    }

    readonly alterationsEnrichmentAnalysisGroups = remoteData({
        await: () => [
            this.enrichmentAnalysisGroups,
            this.selectedStudyMutationEnrichmentProfileMap,
            this.selectedStudyCopyNumberEnrichmentProfileMap,
            this.selectedStudyStructuralVariantEnrichmentProfileMap,
        ],
        invoke: () => {
            return Promise.resolve(
                this.enrichmentAnalysisGroups.result!.map(group => {
                    return {
                        ...group,
                        description: `Number (percentage) of ${
                            this.usePatientLevelEnrichments
                                ? 'patients'
                                : 'samples'
                        } in ${
                            group.name
                        } that are profiled for, and altered in, listed gene.`,
                    };
                })
            );
        },
    });

    readonly alterationsEnrichmentDataRequestGroups = remoteData({
        await: () => [
            this.alterationsEnrichmentAnalysisGroups,
            this.selectedStudyMutationEnrichmentProfileMap,
            this.selectedStudyCopyNumberEnrichmentProfileMap,
            this.selectedStudyStructuralVariantEnrichmentProfileMap,
        ],
        invoke: () => {
            if (
                _(this.selectedMutationEnrichmentEventTypes)
                    .values()
                    .some() ||
                _(this.selectedCopyNumberEnrichmentEventTypes)
                    .values()
                    .some() ||
                this.isStructuralVariantEnrichmentSelected
            ) {
                return Promise.resolve(
                    this.enrichmentAnalysisGroups.result!.reduce(
                        (acc: MolecularProfileCasesGroupFilter[], group) => {
                            let molecularProfileCaseIdentifiers: {
                                caseId: string;
                                molecularProfileId: string;
                            }[] = [];
                            group.samples.forEach(sample => {
                                if (
                                    this
                                        .selectedStudyMutationEnrichmentProfileMap
                                        .result![sample.studyId]
                                ) {
                                    molecularProfileCaseIdentifiers.push({
                                        caseId: this.usePatientLevelEnrichments
                                            ? sample.patientId
                                            : sample.sampleId,
                                        molecularProfileId: this
                                            .selectedStudyMutationEnrichmentProfileMap
                                            .result![sample.studyId]
                                            .molecularProfileId,
                                    });
                                }
                                if (
                                    this
                                        .selectedStudyCopyNumberEnrichmentProfileMap
                                        .result![sample.studyId]
                                ) {
                                    molecularProfileCaseIdentifiers.push({
                                        caseId: this.usePatientLevelEnrichments
                                            ? sample.patientId
                                            : sample.sampleId,
                                        molecularProfileId: this
                                            .selectedStudyCopyNumberEnrichmentProfileMap
                                            .result![sample.studyId]
                                            .molecularProfileId,
                                    });
                                }
                                if (
                                    this
                                        .selectedStudyStructuralVariantEnrichmentProfileMap
                                        .result![sample.studyId]
                                ) {
                                    molecularProfileCaseIdentifiers.push({
                                        caseId: this.usePatientLevelEnrichments
                                            ? sample.patientId
                                            : sample.sampleId,
                                        molecularProfileId: this
                                            .selectedStudyStructuralVariantEnrichmentProfileMap
                                            .result![sample.studyId]
                                            .molecularProfileId,
                                    });
                                }
                            });

                            if (molecularProfileCaseIdentifiers.length > 0) {
                                acc.push({
                                    name: group.name,
                                    molecularProfileCaseIdentifiers,
                                });
                            }
                            return acc;
                        },
                        []
                    )
                );
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly mutationsEnrichmentDataRequestGroups = remoteData({
        await: () => [
            this.alterationsEnrichmentAnalysisGroups,
            this.selectedStudyMutationEnrichmentProfileMap,
        ],
        invoke: () => {
            if (
                _(this.selectedMutationEnrichmentEventTypes)
                    .values()
                    .some()
            ) {
                return Promise.resolve(
                    this.enrichmentAnalysisGroups.result!.reduce(
                        (acc: MolecularProfileCasesGroupFilter[], group) => {
                            let molecularProfileCaseIdentifiers: {
                                caseId: string;
                                molecularProfileId: string;
                            }[] = [];
                            group.samples.forEach(sample => {
                                if (
                                    this
                                        .selectedStudyMutationEnrichmentProfileMap
                                        .result![sample.studyId]
                                ) {
                                    molecularProfileCaseIdentifiers.push({
                                        caseId: this.usePatientLevelEnrichments
                                            ? sample.patientId
                                            : sample.sampleId,
                                        molecularProfileId: this
                                            .selectedStudyMutationEnrichmentProfileMap
                                            .result![sample.studyId]
                                            .molecularProfileId,
                                    });
                                }
                            });

                            if (molecularProfileCaseIdentifiers.length > 0) {
                                acc.push({
                                    name: group.name,
                                    molecularProfileCaseIdentifiers,
                                });
                            }
                            return acc;
                        },
                        []
                    )
                );
            } else {
                return Promise.resolve([]);
            }
        },
    });

    public readonly alterationsEnrichmentData = makeEnrichmentDataPromise({
        await: () => [this.alterationsEnrichmentDataRequestGroups],
        resultsViewPageStore: this.resultsViewStore,
        getSelectedProfileMaps: () => [
            this.selectedStudyMutationEnrichmentProfileMap.result!,
            this.selectedStudyCopyNumberEnrichmentProfileMap.result!,
            this.selectedStudyStructuralVariantEnrichmentProfileMap.result!,
        ],
        referenceGenesPromise: this.hugoGeneSymbolToReferenceGene,
        fetchData: () => {
            if (
                (!_.isEmpty(
                    this.alterationsEnrichmentDataRequestGroups.result
                ) &&
                    (_(this.selectedMutationEnrichmentEventTypes)
                        .values()
                        .some() ||
                        _(this.selectedCopyNumberEnrichmentEventTypes)
                            .values()
                            .some())) ||
                this.isStructuralVariantEnrichmentSelected
            ) {
                const groupsAndAlterationTypes = {
                    molecularProfileCasesGroupFilter: this
                        .alterationsEnrichmentDataRequestGroups.result!,
                    alterationEventTypes: ({
                        copyNumberAlterationEventTypes: getCopyNumberEventTypesAPIParameter(
                            this.selectedCopyNumberEnrichmentEventTypes
                        ),
                        mutationEventTypes: getMutationEventTypesAPIParameter(
                            this.selectedMutationEnrichmentEventTypes
                        ),
                        structuralVariants: !!this
                            .isStructuralVariantEnrichmentSelected,
                        includeDriver: this.driverAnnotationSettings
                            .includeDriver,
                        includeVUS: this.driverAnnotationSettings.includeVUS,
                        includeUnknownOncogenicity: this
                            .driverAnnotationSettings
                            .includeUnknownOncogenicity,
                        tiersBooleanMap: this.selectedDriverTiersMap,
                        includeUnknownTier: this.driverAnnotationSettings
                            .includeUnknownTier,
                        includeGermline: this.includeGermlineMutations,
                        includeSomatic: this.includeSomaticMutations,
                        includeUnknownStatus: this
                            .includeUnknownStatusMutations,
                    } as unknown) as AlterationFilter,
                };

                return internalClient.fetchAlterationEnrichmentsUsingPOST({
                    enrichmentType: this.usePatientLevelEnrichments
                        ? 'PATIENT'
                        : 'SAMPLE',
                    molecularProfileCasesGroupAndAlterationTypeFilter: groupsAndAlterationTypes,
                });
            }
            return Promise.resolve([]);
        },
    });

    public readonly alterationEnrichmentRowData = remoteData<
        AlterationEnrichmentRow[]
    >({
        await: () => [
            this.alterationsEnrichmentData,
            this.alterationsEnrichmentAnalysisGroups,
        ],
        invoke: async () => {
            return getAlterationRowData(
                this.alterationsEnrichmentData.result!,
                this.resultsViewStore
                    ? this.resultsViewStore.hugoGeneSymbols
                    : [],
                this.alterationsEnrichmentAnalysisGroups.result!
            );
        },
    });

    public readonly mutationsEnrichmentData = makeEnrichmentDataPromise({
        await: () => [this.mutationsEnrichmentDataRequestGroups],
        resultsViewPageStore: this.resultsViewStore,
        getSelectedProfileMaps: () => [
            this.selectedStudyMutationEnrichmentProfileMap.result!,
        ],
        referenceGenesPromise: this.hugoGeneSymbolToReferenceGene,
        fetchData: () => {
            if (
                this.mutationsEnrichmentDataRequestGroups.result &&
                this.mutationsEnrichmentDataRequestGroups.result.length > 1 &&
                _(this.selectedMutationEnrichmentEventTypes)
                    .values()
                    .some()
            ) {
                const groupsAndAlterationTypes = {
                    molecularProfileCasesGroupFilter: this
                        .mutationsEnrichmentDataRequestGroups.result!,
                    alterationEventTypes: ({
                        mutationEventTypes: getMutationEventTypesAPIParameter(
                            this.selectedMutationEnrichmentEventTypes
                        ),
                        includeDriver: this.driverAnnotationSettings
                            .includeDriver,
                        includeVUS: this.driverAnnotationSettings.includeVUS,
                        includeUnknownOncogenicity: this
                            .driverAnnotationSettings
                            .includeUnknownOncogenicity,
                        tiersBooleanMap: this.selectedDriverTiersMap,
                        includeUnknownTier: this.driverAnnotationSettings
                            .includeUnknownTier,
                        includeGermline: this.includeGermlineMutations,
                        includeSomatic: this.includeSomaticMutations,
                        includeUnknownStatus: this
                            .includeUnknownStatusMutations,
                    } as unknown) as AlterationFilter,
                };

                return internalClient.fetchAlterationEnrichmentsUsingPOST({
                    enrichmentType: this.usePatientLevelEnrichments
                        ? 'PATIENT'
                        : 'SAMPLE',
                    molecularProfileCasesGroupAndAlterationTypeFilter: groupsAndAlterationTypes,
                });
            }
            return Promise.resolve([]);
        },
    });

    readonly genesSortedByMutationFrequency = remoteData<string[]>({
        await: () => [
            this.mutationsEnrichmentData,
            this.alterationsEnrichmentAnalysisGroups,
        ],
        invoke: async () => {
            const alterationRowData: AlterationEnrichmentRow[] = getAlterationRowData(
                this.mutationsEnrichmentData.result!,
                this.resultsViewStore
                    ? this.resultsViewStore.hugoGeneSymbols
                    : [],
                this.alterationsEnrichmentAnalysisGroups.result!
            );
            alterationRowData.sort(compareByAlterationPercentage);
            return alterationRowData.map(a => a.hugoGeneSymbol);
        },
    });

    readonly genesSortedByAlterationFrequency = remoteData<string[]>({
        await: () => [
            this.alterationEnrichmentRowData,
            this.alterationsEnrichmentAnalysisGroups,
        ],
        invoke: async () => {
            const alterationRowData: AlterationEnrichmentRow[] = this
                .alterationEnrichmentRowData.result!;
            // get a copy of the list to keep the original order intact
            // this is to keep the order of rows in the alteration table as is
            alterationRowData.slice().sort(compareByAlterationPercentage);
            return alterationRowData.map(a => a.hugoGeneSymbol);
        },
    });

    readonly mrnaEnrichmentAnalysisGroups = remoteData({
        await: () => [
            this.selectedmRNAEnrichmentProfileMap,
            this.enrichmentAnalysisGroups,
        ],
        invoke: () => {
            let studyIds = Object.keys(
                this.selectedmRNAEnrichmentProfileMap.result!
            );
            // assumes single study for now
            if (studyIds.length === 1) {
                return Promise.resolve(
                    this.enrichmentAnalysisGroups.result!.reduce(
                        (acc: EnrichmentAnalysisComparisonGroup[], group) => {
                            // filter samples having mutation profile
                            const filteredSamples = group.samples.filter(
                                sample =>
                                    this.selectedmRNAEnrichmentProfileMap
                                        .result![sample.studyId] !== undefined
                            );
                            if (filteredSamples.length > 0) {
                                acc.push({
                                    ...group,
                                    samples: filteredSamples,
                                    description: `samples in ${group.name}`,
                                });
                            }
                            return acc;
                        },
                        []
                    )
                );
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly mrnaEnrichmentDataRequestGroups = remoteData({
        await: () => [
            this.mrnaEnrichmentAnalysisGroups,
            this.selectedmRNAEnrichmentProfileMap,
        ],
        invoke: () => {
            return Promise.resolve(
                this.mrnaEnrichmentAnalysisGroups.result!.map(group => {
                    const molecularProfileCaseIdentifiers = group.samples.map(
                        sample => ({
                            caseId: sample.sampleId,
                            molecularProfileId: this
                                .selectedmRNAEnrichmentProfileMap.result![
                                sample.studyId
                            ].molecularProfileId,
                        })
                    );
                    return {
                        name: group.name,
                        molecularProfileCaseIdentifiers,
                    };
                })
            );
        },
    });

    readonly mRNAEnrichmentData = makeEnrichmentDataPromise({
        await: () => [this.mrnaEnrichmentDataRequestGroups],
        getSelectedProfileMaps: () => [
            // returns an empty array if the selected study doesn't have any mRNA profiles
            this.selectedmRNAEnrichmentProfileMap.result!,
        ],
        referenceGenesPromise: this.hugoGeneSymbolToReferenceGene,
        fetchData: () => {
            if (
                this.mrnaEnrichmentDataRequestGroups.result &&
                this.mrnaEnrichmentDataRequestGroups.result.length > 1
            ) {
                return internalClient.fetchGenomicEnrichmentsUsingPOST({
                    enrichmentType: 'SAMPLE',
                    groupsContainingSampleAndMolecularProfileIdentifiers: this
                        .mrnaEnrichmentDataRequestGroups.result!,
                });
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly proteinEnrichmentAnalysisGroups = remoteData({
        await: () => [
            this.selectedProteinEnrichmentProfileMap,
            this.enrichmentAnalysisGroups,
        ],
        invoke: () => {
            let studyIds = Object.keys(
                this.selectedProteinEnrichmentProfileMap.result!
            );
            // assumes single study for now
            if (studyIds.length === 1) {
                return Promise.resolve(
                    this.enrichmentAnalysisGroups.result!.reduce(
                        (acc: EnrichmentAnalysisComparisonGroup[], group) => {
                            // filter samples having mutation profile
                            const filteredSamples = group.samples.filter(
                                sample =>
                                    this.selectedProteinEnrichmentProfileMap
                                        .result![sample.studyId] !== undefined
                            );
                            if (filteredSamples.length > 0) {
                                acc.push({
                                    ...group,
                                    samples: filteredSamples,
                                    description: `samples in ${group.name}`,
                                });
                            }
                            return acc;
                        },
                        []
                    )
                );
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly proteinEnrichmentDataRequestGroups = remoteData({
        await: () => [
            this.proteinEnrichmentAnalysisGroups,
            this.selectedProteinEnrichmentProfileMap,
        ],
        invoke: () => {
            return Promise.resolve(
                this.proteinEnrichmentAnalysisGroups.result!.map(group => {
                    const molecularProfileCaseIdentifiers = group.samples.map(
                        sample => ({
                            caseId: sample.sampleId,
                            molecularProfileId: this
                                .selectedProteinEnrichmentProfileMap.result![
                                sample.studyId
                            ].molecularProfileId,
                        })
                    );
                    return {
                        name: group.name,
                        molecularProfileCaseIdentifiers,
                    };
                })
            );
        },
    });

    readonly proteinEnrichmentData = makeEnrichmentDataPromise({
        await: () => [this.proteinEnrichmentDataRequestGroups],
        referenceGenesPromise: this.hugoGeneSymbolToReferenceGene,
        getSelectedProfileMaps: () => [
            // returns an empty array if the selected study doesn't have any protein profiles
            this.selectedProteinEnrichmentProfileMap.result!,
        ],
        fetchData: () => {
            if (
                this.proteinEnrichmentDataRequestGroups.result &&
                this.proteinEnrichmentDataRequestGroups.result.length > 1
            ) {
                return internalClient.fetchGenomicEnrichmentsUsingPOST({
                    enrichmentType: 'SAMPLE',
                    groupsContainingSampleAndMolecularProfileIdentifiers: this
                        .proteinEnrichmentDataRequestGroups.result!,
                });
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly methylationEnrichmentAnalysisGroups = remoteData({
        await: () => [
            this.selectedMethylationEnrichmentProfileMap,
            this.enrichmentAnalysisGroups,
        ],
        invoke: () => {
            let studyIds = Object.keys(
                this.selectedMethylationEnrichmentProfileMap.result!
            );
            // assumes single study for now
            if (studyIds.length === 1) {
                return Promise.resolve(
                    this.enrichmentAnalysisGroups.result!.reduce(
                        (acc: EnrichmentAnalysisComparisonGroup[], group) => {
                            // filter samples having mutation profile
                            const filteredSamples = group.samples.filter(
                                sample =>
                                    this.selectedMethylationEnrichmentProfileMap
                                        .result![sample.studyId] !== undefined
                            );
                            if (filteredSamples.length > 0) {
                                acc.push({
                                    ...group,
                                    samples: filteredSamples,
                                    description: `samples in ${group.name}`,
                                });
                            }
                            return acc;
                        },
                        []
                    )
                );
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly methylationEnrichmentDataRequestGroups = remoteData({
        await: () => [
            this.methylationEnrichmentAnalysisGroups,
            this.selectedMethylationEnrichmentProfileMap,
        ],
        invoke: () => {
            return Promise.resolve(
                this.methylationEnrichmentAnalysisGroups.result!.map(group => {
                    const molecularProfileCaseIdentifiers = group.samples.map(
                        sample => ({
                            caseId: sample.sampleId,
                            molecularProfileId: this
                                .selectedMethylationEnrichmentProfileMap
                                .result![sample.studyId].molecularProfileId,
                        })
                    );
                    return {
                        name: group.name,
                        molecularProfileCaseIdentifiers,
                    };
                })
            );
        },
    });

    readonly methylationEnrichmentData = makeEnrichmentDataPromise({
        await: () => [this.methylationEnrichmentDataRequestGroups],
        referenceGenesPromise: this.hugoGeneSymbolToReferenceGene,
        getSelectedProfileMaps: () => [
            // returns an empty array if the selected study doesn't have any methylation profiles
            this.selectedMethylationEnrichmentProfileMap.result!,
        ],
        fetchData: () => {
            if (
                this.methylationEnrichmentDataRequestGroups.result &&
                this.methylationEnrichmentDataRequestGroups.result.length > 1
            ) {
                return internalClient.fetchGenomicEnrichmentsUsingPOST({
                    enrichmentType: 'SAMPLE',
                    groupsContainingSampleAndMolecularProfileIdentifiers: this
                        .methylationEnrichmentDataRequestGroups.result!,
                });
            } else {
                return Promise.resolve([]);
            }
        },
    });

    readonly gaEnrichmentGroupsByAssayType = remoteData({
        await: () => [
            this
                .selectedAllGenericAssayEnrichmentProfileMapGroupedByGenericAssayType,
            this.enrichmentAnalysisGroups,
        ],
        invoke: () => {
            return Promise.resolve(
                _.mapValues(
                    this
                        .selectedAllGenericAssayEnrichmentProfileMapGroupedByGenericAssayType
                        .result!,
                    selectedGenericAssayEnrichmentProfileMap => {
                        let studyIds = Object.keys(
                            selectedGenericAssayEnrichmentProfileMap
                        );
                        // assumes single study for now
                        if (studyIds.length === 1) {
                            return this.enrichmentAnalysisGroups.result!.reduce(
                                (
                                    acc: EnrichmentAnalysisComparisonGroup[],
                                    group
                                ) => {
                                    // filter samples having mutation profile
                                    const filteredSamples = group.samples.filter(
                                        sample =>
                                            selectedGenericAssayEnrichmentProfileMap[
                                                sample.studyId
                                            ] !== undefined
                                    );
                                    if (filteredSamples.length > 0) {
                                        acc.push({
                                            ...group,
                                            samples: filteredSamples,
                                            description: `samples in ${group.name}`,
                                        });
                                    }
                                    return acc;
                                },
                                []
                            );
                        } else {
                            return [];
                        }
                    }
                )
            );
        },
    });

    readonly gaBinaryEnrichmentGroupsByAssayType = remoteData({
        await: () => [
            this
                .selectedGenericAssayBinaryEnrichmentProfileMapGroupedByGenericAssayType,
            this.enrichmentAnalysisGroups,
        ],
        invoke: () => {
            return Promise.resolve(
                _.mapValues(
                    this
                        .selectedGenericAssayBinaryEnrichmentProfileMapGroupedByGenericAssayType
                        .result!,
                    selectedGenericAssayBinaryEnrichmentProfileMap => {
                        let studyIds = Object.keys(
                            selectedGenericAssayBinaryEnrichmentProfileMap
                        );
                        // assumes single study for now
                        if (studyIds.length === 1) {
                            return this.enrichmentAnalysisGroups.result!.reduce(
                                (
                                    acc: EnrichmentAnalysisComparisonGroup[],
                                    group
                                ) => {
                                    // filter samples having mutation profile
                                    const filteredSamples = group.samples.filter(
                                        sample =>
                                            selectedGenericAssayBinaryEnrichmentProfileMap[
                                                sample.studyId
                                            ] !== undefined
                                    );
                                    if (filteredSamples.length > 0) {
                                        acc.push({
                                            ...group,
                                            samples: filteredSamples,
                                            description: `samples in ${group.name}`,
                                        });
                                    }
                                    return acc;
                                },
                                []
                            );
                        } else {
                            return [];
                        }
                    }
                )
            );
        },
    });

    readonly gaCategoricalEnrichmentGroupsByAssayType = remoteData({
        await: () => [
            this
                .selectedGenericAssayCategoricalEnrichmentProfileMapGroupedByGenericAssayType,
            this.enrichmentAnalysisGroups,
        ],
        invoke: () => {
            return Promise.resolve(
                _.mapValues(
                    this
                        .selectedGenericAssayCategoricalEnrichmentProfileMapGroupedByGenericAssayType
                        .result!,
                    selectedGenericAssayCategoricalEnrichmentProfileMap => {
                        let studyIds = Object.keys(
                            selectedGenericAssayCategoricalEnrichmentProfileMap
                        );
                        // assumes single study for now
                        if (studyIds.length === 1) {
                            return this.enrichmentAnalysisGroups.result!.reduce(
                                (
                                    acc: EnrichmentAnalysisComparisonGroup[],
                                    group
                                ) => {
                                    // filter samples having mutation profile
                                    const filteredSamples = group.samples.filter(
                                        sample =>
                                            selectedGenericAssayCategoricalEnrichmentProfileMap[
                                                sample.studyId
                                            ] !== undefined
                                    );
                                    if (filteredSamples.length > 0) {
                                        acc.push({
                                            ...group,
                                            samples: filteredSamples,
                                            description: `samples in ${group.name}`,
                                        });
                                    }
                                    return acc;
                                },
                                []
                            );
                        } else {
                            return [];
                        }
                    }
                )
            );
        },
    });

    readonly gaEnrichmentDataQueryByAssayType = remoteData({
        await: () => [
            this.gaEnrichmentGroupsByAssayType,
            this
                .selectedAllGenericAssayEnrichmentProfileMapGroupedByGenericAssayType,
        ],
        invoke: () => {
            return Promise.resolve(
                _.mapValues(
                    this.gaEnrichmentGroupsByAssayType.result!,
                    (
                        genericAssayEnrichmentAnalysisGroups,
                        genericAssayType
                    ) => {
                        return genericAssayEnrichmentAnalysisGroups.map(
                            group => {
                                const molecularProfileCaseIdentifiers = group.samples.map(
                                    sample => ({
                                        caseId: sample.sampleId,
                                        molecularProfileId: this
                                            .selectedAllGenericAssayEnrichmentProfileMapGroupedByGenericAssayType
                                            .result![genericAssayType][
                                            sample.studyId
                                        ].molecularProfileId,
                                    })
                                );
                                return {
                                    name: group.name,
                                    molecularProfileCaseIdentifiers,
                                };
                            }
                        );
                    }
                )
            );
        },
    });

    readonly gaBinaryEnrichmentDataQueryByAssayType = remoteData({
        await: () => [
            this.gaBinaryEnrichmentGroupsByAssayType,
            this
                .selectedGenericAssayBinaryEnrichmentProfileMapGroupedByGenericAssayType,
        ],
        invoke: () => {
            return Promise.resolve(
                _.mapValues(
                    this.gaBinaryEnrichmentGroupsByAssayType.result!,
                    (
                        genericAssayEnrichmentAnalysisGroups,
                        genericAssayType
                    ) => {
                        return genericAssayEnrichmentAnalysisGroups.map(
                            group => {
                                const molecularProfileCaseIdentifiers = group.samples.map(
                                    sample => ({
                                        caseId: sample.sampleId,
                                        molecularProfileId: this
                                            .selectedGenericAssayBinaryEnrichmentProfileMapGroupedByGenericAssayType
                                            .result![genericAssayType][
                                            sample.studyId
                                        ].molecularProfileId,
                                    })
                                );
                                return {
                                    name: group.name,
                                    molecularProfileCaseIdentifiers,
                                };
                            }
                        );
                    }
                )
            );
        },
    });

    readonly gaCategoricalEnrichmentDataQueryByAssayType = remoteData({
        await: () => [
            this.gaCategoricalEnrichmentGroupsByAssayType,
            this
                .selectedGenericAssayCategoricalEnrichmentProfileMapGroupedByGenericAssayType,
        ],
        invoke: () => {
            return Promise.resolve(
                _.mapValues(
                    this.gaCategoricalEnrichmentGroupsByAssayType.result!,
                    (
                        genericAssayEnrichmentAnalysisGroups,
                        genericAssayType
                    ) => {
                        return genericAssayEnrichmentAnalysisGroups.map(
                            group => {
                                const molecularProfileCaseIdentifiers = group.samples.map(
                                    sample => ({
                                        caseId: sample.sampleId,
                                        molecularProfileId: this
                                            .selectedGenericAssayCategoricalEnrichmentProfileMapGroupedByGenericAssayType
                                            .result![genericAssayType][
                                            sample.studyId
                                        ].molecularProfileId,
                                    })
                                );
                                return {
                                    name: group.name,
                                    molecularProfileCaseIdentifiers,
                                };
                            }
                        );
                    }
                )
            );
        },
    });
    readonly gaEnrichmentDataByAssayType = remoteData({
        await: () => [this.gaEnrichmentDataQueryByAssayType],
        invoke: () => {
            return Promise.resolve(
                _.mapValues(
                    this.gaEnrichmentDataQueryByAssayType.result!,
                    (
                        genericAssayEnrichmentDataRequestGroups,
                        genericAssayType
                    ) => {
                        return makeGenericAssayEnrichmentDataPromise({
                            await: () => [],
                            getSelectedProfileMap: () =>
                                this
                                    .selectedAllGenericAssayEnrichmentProfileMapGroupedByGenericAssayType
                                    .result![genericAssayType], // returns an empty array if the selected study doesn't have any generic assay profiles
                            fetchData: () => {
                                if (
                                    genericAssayEnrichmentDataRequestGroups &&
                                    genericAssayEnrichmentDataRequestGroups.length >
                                        1
                                ) {
                                    return internalClient.fetchGenericAssayEnrichmentsUsingPOST(
                                        {
                                            enrichmentType: 'SAMPLE',
                                            groupsContainingSampleAndMolecularProfileIdentifiers: genericAssayEnrichmentDataRequestGroups,
                                        }
                                    );
                                } else {
                                    return Promise.resolve([]);
                                }
                            },
                        });
                    }
                )
            );
        },
    });

    readonly gaBinaryEnrichmentDataByAssayType = remoteData({
        await: () => [this.gaBinaryEnrichmentDataQueryByAssayType],
        invoke: () => {
            return Promise.resolve(
                _.mapValues(
                    this.gaBinaryEnrichmentDataQueryByAssayType.result!,
                    (
                        genericAssayEnrichmentDataRequestGroups,
                        genericAssayType
                    ) => {
                        return makeGenericAssayBinaryEnrichmentDataPromise({
                            await: () => [],
                            getSelectedProfileMap: () =>
                                this
                                    .selectedGenericAssayBinaryEnrichmentProfileMapGroupedByGenericAssayType
                                    .result![genericAssayType], // returns an empty array if the selected study doesn't have any generic assay profiles
                            fetchData: () => {
                                if (
                                    genericAssayEnrichmentDataRequestGroups &&
                                    genericAssayEnrichmentDataRequestGroups.length >
                                        1
                                ) {
                                    return internalClient.fetchGenericAssayBinaryDataEnrichmentInMultipleMolecularProfilesUsingPOST(
                                        {
                                            enrichmentType: 'SAMPLE',
                                            groupsContainingSampleAndMolecularProfileIdentifiers: genericAssayEnrichmentDataRequestGroups,
                                        }
                                    );
                                } else {
                                    return Promise.resolve([]);
                                }
                            },
                        });
                    }
                )
            );
        },
    });

    readonly gaCategoricalEnrichmentDataByAssayType = remoteData({
        await: () => [this.gaCategoricalEnrichmentDataQueryByAssayType],
        invoke: () => {
            return Promise.resolve(
                _.mapValues(
                    this.gaCategoricalEnrichmentDataQueryByAssayType.result!,
                    (
                        genericAssayEnrichmentDataRequestGroups,
                        genericAssayType
                    ) => {
                        return makeGenericAssayCategoricalEnrichmentDataPromise(
                            {
                                await: () => [],
                                getSelectedProfileMap: () =>
                                    this
                                        .selectedGenericAssayCategoricalEnrichmentProfileMapGroupedByGenericAssayType
                                        .result![genericAssayType], // returns an empty array if the selected study doesn't have any generic assay profiles
                                fetchData: () => {
                                    if (
                                        genericAssayEnrichmentDataRequestGroups &&
                                        genericAssayEnrichmentDataRequestGroups.length >
                                            1
                                    ) {
                                        return internalClient.fetchGenericAssayCategoricalDataEnrichmentInMultipleMolecularProfilesUsingPOST(
                                            {
                                                enrichmentType: 'SAMPLE',
                                                groupsContainingSampleAndMolecularProfileIdentifiers: genericAssayEnrichmentDataRequestGroups,
                                            }
                                        );
                                    } else {
                                        return Promise.resolve([]);
                                    }
                                },
                            }
                        );
                    }
                )
            );
        },
    });

    @computed get survivalTabShowable() {
        // TODO: refactor to check clinica-event data
        return (
            (this.predefinedSurvivalClinicalDataExists.isComplete &&
                this.clinicalEventOptions.isComplete &&
                this.predefinedSurvivalClinicalDataExists.result) ||
            !_.isEmpty(this.clinicalEventOptions.result!)
        );
    }

    @computed get showSurvivalTab() {
        return !!(
            this.survivalTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(GroupComparisonTab.SURVIVAL))
        );
    }

    @computed get survivalTabUnavailable() {
        // grey out if more than 10 active groups
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length > 10) ||
            !this.survivalTabShowable
        );
    }

    @computed get clinicalTabUnavailable() {
        // grey out if active groups is less than 2
        return (
            this.activeGroups.isComplete && this.activeGroups.result.length < 2
        );
    }

    @computed get mRNATabShowable() {
        return (
            this.mRNAEnrichmentProfiles.isComplete &&
            this.mRNAEnrichmentProfiles.result!.length > 0
        );
    }

    @computed get showMRNATab() {
        return !!(
            this.mRNATabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(GroupComparisonTab.MRNA))
        );
    }

    @computed get mRNATabUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length < 2) || //less than two active groups
            (this.activeStudyIds.isComplete &&
                this.activeStudyIds.result.length > 1) || //more than one active study
            !this.mRNATabShowable
        );
    }

    @computed get proteinTabShowable() {
        return (
            this.proteinEnrichmentProfiles.isComplete &&
            this.proteinEnrichmentProfiles.result!.length > 0
        );
    }

    @computed get showProteinTab() {
        return !!(
            this.proteinTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(GroupComparisonTab.PROTEIN))
        );
    }

    @computed get proteinTabUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length < 2) || //less than two active groups
            (this.activeStudyIds.isComplete &&
                this.activeStudyIds.result.length > 1) || //more than one active study
            !this.proteinTabShowable
        );
    }

    @computed get methylationTabShowable() {
        return (
            this.methylationEnrichmentProfiles.isComplete &&
            this.methylationEnrichmentProfiles.result!.length > 0
        );
    }

    @computed get showMethylationTab() {
        return !!(
            this.methylationTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(GroupComparisonTab.DNAMETHYLATION))
        );
    }

    @computed get methylationTabUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length < 2) || //less than two active groups
            (this.activeStudyIds.isComplete &&
                this.activeStudyIds.result.length > 1) || //more than one active study
            !this.methylationTabShowable
        );
    }

    @computed get alterationsTabShowable() {
        return (
            this.mutationEnrichmentProfiles.isComplete &&
            this.copyNumberEnrichmentProfiles.isComplete &&
            (this.mutationEnrichmentProfiles.result!.length > 0 ||
                this.copyNumberEnrichmentProfiles.result!.length > 0)
        );
    }

    @computed get showAlterationsTab() {
        return !!(
            this.alterationsTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(GroupComparisonTab.ALTERATIONS))
        );
    }

    @computed get alterationsTabUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length < 2) || //less than two active groups
            !this.alterationsTabShowable
        );
    }

    @computed get isMutationsTabShowable() {
        return (
            this.mutationEnrichmentProfiles.isComplete &&
            this.mutationEnrichmentProfiles.result!.length > 0
        );
    }

    @computed get showMutationsTab() {
        return !!(
            this.isMutationsTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(GroupComparisonTab.MUTATIONS))
        );
    }

    @computed get isMutationsTabUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length !== 2) || // not two active groups
            !this.isMutationsTabShowable
        );
    }

    @computed get genericAssayTabShowable() {
        return (
            this.genericAssayEnrichmentProfilesGroupedByGenericAssayType
                .isComplete &&
            _.size(
                this.genericAssayEnrichmentProfilesGroupedByGenericAssayType
                    .result!
            ) > 0
        );
    }

    @computed get genericAssayBinaryTabShowable() {
        return (
            this.genericAssayBinaryEnrichmentProfilesGroupedByGenericAssayType
                .isComplete &&
            _.size(
                this
                    .genericAssayBinaryEnrichmentProfilesGroupedByGenericAssayType
                    .result!
            ) > 0
        );
    }

    @computed get genericAssayCategoricalTabShowable() {
        return (
            this
                .genericAssayCategoricalEnrichmentProfilesGroupedByGenericAssayType
                .isComplete &&
            _.size(
                this
                    .genericAssayCategoricalEnrichmentProfilesGroupedByGenericAssayType
                    .result!
            ) > 0
        );
    }

    @computed get showGenericAssayTab() {
        return !!(
            this.genericAssayTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(
                    GroupComparisonTab.GENERIC_ASSAY_PREFIX
                ))
        );
    }

    @computed get showGenericAssayBinaryTab() {
        return !!(
            this.genericAssayBinaryTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(
                    GroupComparisonTab.GENERIC_ASSAY_BINARY_PREFIX
                ))
        );
    }

    @computed get showGenericAssayCategoricalTab() {
        return !!(
            this.genericAssayCategoricalTabShowable ||
            (this.activeGroups.isComplete &&
                this.activeGroups.result!.length === 0 &&
                this.tabHasBeenShown.get(
                    GroupComparisonTab.GENERIC_ASSAY_CATEGORICAL_PREFIX
                ))
        );
    }

    @computed get genericAssayTabUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length < 2) || //less than two active groups
            (this.activeStudyIds.isComplete &&
                this.activeStudyIds.result.length > 1) || //more than one active study
            !this.genericAssayTabShowable
        );
    }

    @computed get genericAssayBinaryTabUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length < 2) || //less than two active groups
            (this.activeStudyIds.isComplete &&
                this.activeStudyIds.result.length > 1) || //more than one active study
            !this.genericAssayBinaryTabShowable
        );
    }

    @computed get genericAssayCategoricalTabUnavailable() {
        return (
            (this.activeGroups.isComplete &&
                this.activeGroups.result.length < 2) || //less than two active groups
            (this.activeStudyIds.isComplete &&
                this.activeStudyIds.result.length > 1) || //more than one active study
            !this.genericAssayCategoricalTabShowable
        );
    }

    public readonly sampleMap = remoteData({
        await: () => [this.samples],
        invoke: () => {
            const sampleSet = new ComplexKeyMap<Sample>();
            for (const sample of this.samples.result!) {
                sampleSet.set(
                    { studyId: sample.studyId, sampleId: sample.sampleId },
                    sample
                );
            }
            return Promise.resolve(sampleSet);
        },
    });

    readonly patientKeys = remoteData({
        await: () => [this.samples],
        invoke: () => {
            return Promise.resolve(
                _.uniq(this.samples.result!.map(s => s.uniquePatientKey))
            );
        },
    });

    public readonly patientToSamplesSet = remoteData({
        await: () => [this.samples],
        invoke: () => {
            const ret = new ComplexKeyGroupsMap<Sample>();
            for (const sample of this.samples.result!) {
                ret.add(
                    { studyId: sample.studyId, patientId: sample.patientId },
                    sample
                );
            }
            return Promise.resolve(ret);
        },
    });

    public readonly patientKeyToSamples = remoteData({
        await: () => [this.samples],
        invoke: () => {
            return Promise.resolve(
                _.groupBy(
                    this.samples.result!,
                    sample => sample.uniquePatientKey
                )
            );
        },
    });

    public readonly sampleKeyToSample = remoteData({
        await: () => [this.samples],
        invoke: () => {
            let sampleSet = _.reduce(
                this.samples.result!,
                (acc, sample) => {
                    acc[sample.uniqueSampleKey] = sample;
                    return acc;
                },
                {} as { [uniqueSampleKey: string]: Sample }
            );
            return Promise.resolve(sampleSet);
        },
    });

    readonly filteredAndAnnotatedMutations = remoteData<AnnotatedMutation[]>({
        await: () => [
            this._filteredAndAnnotatedMutationsReport,
            this.sampleKeyToSample,
        ],
        invoke: () => {
            const filteredMutations = compileMutations(
                this._filteredAndAnnotatedMutationsReport.result!,
                !this.driverAnnotationSettings.includeVUS,
                !this.includeGermlineMutations
            );
            const sampleKeyToSample = this.sampleKeyToSample.result!;
            return Promise.resolve(
                filteredMutations.filter(
                    m => m.uniqueSampleKey in sampleKeyToSample
                )
            );
        },
    });

    public readonly sampleKeyToGroups = remoteData({
        await: () => [this._originalGroups, this.sampleMap],
        invoke: () => {
            const sampleSet = this.sampleMap.result!;
            const groups = this._originalGroups.result!;
            const ret: {
                [uniqueSampleKey: string]: { [groupUid: string]: boolean };
            } = {};
            for (const group of groups) {
                for (const studyObject of group.studies) {
                    const studyId = studyObject.id;
                    for (const sampleId of studyObject.samples) {
                        const sample = sampleSet.get({ sampleId, studyId });
                        if (sample) {
                            ret[sample.uniqueSampleKey] =
                                ret[sample.uniqueSampleKey] || {};
                            ret[sample.uniqueSampleKey][group.uid] = true;
                        }
                    }
                }
            }
            return Promise.resolve(ret);
        },
    });

    public readonly patientsVennPartition = remoteData({
        await: () => [
            this._activeGroupsNotOverlapRemoved,
            this.patientToSamplesSet,
            this.activePatientKeysNotOverlapRemoved,
        ],
        invoke: () => {
            const patientToSamplesSet = this.patientToSamplesSet.result!;
            return Promise.resolve(
                partitionCasesByGroupMembership(
                    this._activeGroupsNotOverlapRemoved.result!,
                    group => getPatientIdentifiers([group]),
                    patientIdentifier =>
                        patientToSamplesSet.get({
                            studyId: patientIdentifier.studyId,
                            patientId: patientIdentifier.patientId,
                        })![0].uniquePatientKey,
                    this.activePatientKeysNotOverlapRemoved.result!
                ) as { key: { [uid: string]: boolean }; value: string[] }[]
            );
        },
    });

    readonly predefinedSurvivalClinicalDataExists = remoteData<boolean>({
        await: () => [
            this.activeSamplesNotOverlapRemoved,
            this.predefinedSurvivalClinicalAttributesPrefix,
        ],
        invoke: () =>
            fetchSurvivalDataExists(
                this.activeSamplesNotOverlapRemoved.result!,
                this.predefinedSurvivalClinicalAttributesPrefix.result!
            ),
    });

    readonly predefinedSurvivalClinicalData = remoteData<ClinicalData[]>(
        {
            await: () => [
                this.activeSamplesNotOverlapRemoved,
                this.predefinedSurvivalClinicalAttributesPrefix,
            ],
            invoke: () => {
                if (this.activeSamplesNotOverlapRemoved.result!.length === 0) {
                    return Promise.resolve([]);
                }

                const attributeNames: string[] = _.reduce(
                    this.predefinedSurvivalClinicalAttributesPrefix.result!,
                    (attributeNames, prefix: string) => {
                        attributeNames.push(prefix + '_STATUS');
                        attributeNames.push(prefix + '_MONTHS');
                        return attributeNames;
                    },
                    [] as string[]
                );

                if (attributeNames.length === 0) {
                    return Promise.resolve([]);
                }
                const filter: ClinicalDataMultiStudyFilter = {
                    attributeIds: attributeNames,
                    identifiers: this.activeSamplesNotOverlapRemoved.result!.map(
                        (s: any) => ({
                            entityId: s.patientId,
                            studyId: s.studyId,
                        })
                    ),
                };
                return client.fetchClinicalDataUsingPOST({
                    clinicalDataType: 'PATIENT',
                    clinicalDataMultiStudyFilter: filter,
                });
            },
        },
        []
    );

    readonly survivalClinicalData = remoteData<ClinicalData[]>(
        {
            await: () => [
                this.activeSamplesNotOverlapRemoved,
                this.predefinedSurvivalClinicalData,
                ..._.values(this.customSurvivalDataPromises),
            ],
            invoke: async () => {
                if (this.activeSamplesNotOverlapRemoved.result!.length === 0) {
                    return Promise.resolve([]);
                }
                let response: ClinicalData[] = [];
                if (_.keys(this.customSurvivalPlots).length > 0) {
                    response = _.chain(this.customSurvivalDataPromises)
                        .values()
                        .flatMap(x => x.result || [])
                        .value();
                }
                return [
                    ...this.predefinedSurvivalClinicalData.result,
                    ...response,
                ];
            },
        },
        []
    );

    readonly clinicalEventOptions = remoteData<{
        [key: string]: {
            label: string;
            value: string;
            attributes: ClinicalEventDataWithKey[];
        };
    }>(
        {
            await: () => [this.activeSamplesNotOverlapRemoved],
            invoke: async () => {
                if (this.activeSamplesNotOverlapRemoved.result!.length === 0) {
                    return Promise.resolve({});
                }

                const result = await internalClient.fetchClinicalEventsMetaUsingPOST(
                    {
                        clinicalEventAttributeRequest: {
                            patientIdentifiers: this.activeSamplesNotOverlapRemoved.result!.map(
                                (s: any) => ({
                                    patientId: s.patientId,
                                    studyId: s.studyId,
                                })
                            ),
                            clinicalEventRequests: [],
                        },
                    }
                );
                return _.chain(result)
                    .filter(x =>
                        getServerConfig()
                            .skin_survival_plot_clinical_event_types_show_on_init
                            ? getServerConfig()
                                  .skin_survival_plot_clinical_event_types_show_on_init.split(
                                      ','
                                  )
                                  .includes(x.eventType)
                            : true
                    )
                    .map(x => ({
                        label: x.eventType,
                        value: x.eventType,
                        attributes: x.attributes.map(y => ({
                            ...y,
                            label: `${y.key}::${y.value}`,
                        })),
                    }))
                    .keyBy(x => x.value)
                    .value();
            },
        },
        {}
    );

    readonly activeStudiesClinicalAttributes = remoteData<ClinicalAttribute[]>(
        {
            await: () => [this.activeStudyIds],
            invoke: () => {
                if (this.activeStudyIds.result!.length === 0) {
                    return Promise.resolve([]);
                }
                return client.fetchClinicalAttributesUsingPOST({
                    studyIds: this.activeStudyIds.result!,
                });
            },
        },
        []
    );

    readonly predefinedSurvivalAttributes = remoteData<ClinicalAttribute[]>(
        {
            await: () => [this.activeStudiesClinicalAttributes],
            invoke: async () => {
                return _.filter(
                    this.activeStudiesClinicalAttributes.result,
                    attr =>
                        /_STATUS$/i.test(attr.clinicalAttributeId) ||
                        /_MONTHS$/i.test(attr.clinicalAttributeId)
                );
            },
        },
        []
    );

    readonly allSurvivalAttributes = remoteData<ClinicalAttribute[]>(
        {
            await: () => [
                this.predefinedSurvivalAttributes,
                this.activeStudyIds,
            ],
            invoke: () => {
                const customAttributes = _.chain(toJS(this.customSurvivalPlots))
                    .flatMap((x, y) => {
                        return _.chain(this.activeStudyIds.result || [])
                            .flatMap(studyId => {
                                const description = getSurvivalPlotDescription(
                                    x
                                );

                                var months_attribute: ClinicalAttribute = {
                                    clinicalAttributeId: x.name + '_MONTHS',
                                    datatype: 'NUMBER',
                                    description: `Survival in months ${description}`,
                                    displayName: `Survival (Months) ${x.name}`,
                                    patientAttribute: true,
                                    priority: '1',
                                    studyId: studyId,
                                };
                                var status_attribute: ClinicalAttribute = {
                                    clinicalAttributeId: x.name + '_STATUS',
                                    datatype: 'STRING',
                                    description: `${description}`,
                                    displayName: `Survival status ${x.name}`,
                                    patientAttribute: true,
                                    priority: '1',
                                    studyId: studyId,
                                };
                                return [months_attribute, status_attribute];
                            })
                            .value();
                    })
                    .value();

                return Promise.resolve([
                    ...this.predefinedSurvivalAttributes.result!,
                    ...customAttributes,
                ]);
            },
        },
        []
    );

    readonly survivalClinicalAttributesPrefix = remoteData({
        await: () => [this.allSurvivalAttributes],
        invoke: () => {
            return Promise.resolve(
                getSurvivalClinicalAttributesPrefix(
                    this.allSurvivalAttributes.result!
                )
            );
        },
    });

    readonly predefinedSurvivalClinicalAttributesPrefix = remoteData({
        await: () => [this.activeStudiesClinicalAttributes],
        invoke: () => {
            return Promise.resolve(
                getSurvivalClinicalAttributesPrefix(
                    this.activeStudiesClinicalAttributes.result!
                )
            );
        },
    });

    readonly survivalClinicalDataGroupByUniquePatientKey = remoteData<{
        [key: string]: ClinicalData[];
    }>({
        await: () => [this.survivalClinicalData],
        invoke: async () => {
            return _.groupBy(
                this.survivalClinicalData.result,
                'uniquePatientKey'
            );
        },
    });

    // This method should be updated in the child component
    protected get isLeftTruncationFeatureFlagEnabled() {
        return false;
    }

    @computed get isGeniebpcStudy() {
        if (this.studies.result) {
            const studyIds = this.studies.result.map(s => s.studyId);
            return (
                studyIds.length === 1 &&
                studyIds[0] === 'heme_onc_nsclc_genie_bpc'
            );
        }
        return false;
    }

    readonly survivalEntryMonths = remoteData<
        { [uniquePatientKey: string]: number } | undefined
    >({
        await: () => [this.studies],
        invoke: async () => {
            const studyIds = this.studies.result!.map(s => s.studyId);
            // Please note:
            // The left truncation adjustment is only available for one study: heme_onc_nsclc_genie_bpc at this time
            // clinical attributeId still need to be decided in the future
            if (
                this.isGeniebpcStudy &&
                this.isLeftTruncationFeatureFlagEnabled
            ) {
                const data = await client.getAllClinicalDataInStudyUsingGET({
                    attributeId: 'TT_CPT_REPORT_MOS',
                    clinicalDataType: 'PATIENT',
                    studyId: studyIds[0],
                });
                return data.reduce(
                    (map: { [patientKey: string]: number }, next) => {
                        map[next.uniquePatientKey] = parseFloat(next.value);
                        return map;
                    },
                    {}
                );
            } else {
                return undefined;
            }
        },
    });

    readonly isLeftTruncationAvailable = remoteData<boolean>({
        await: () => [this.survivalEntryMonths],
        invoke: async () => {
            return !!this.survivalEntryMonths.result;
        },
    });

    @action.bound
    public toggleLeftTruncationSelection() {
        this.adjustForLeftTruncation = !this.adjustForLeftTruncation;
    }

    // patientSurvivalsWithoutLeftTruncation is used to compare with patient survival data with left truncation adjustment
    // This is used for generating information about how many patients get excluded by enabling left truncation adjustment
    readonly patientSurvivalsWithoutLeftTruncation = remoteData<{
        [prefix: string]: PatientSurvival[];
    }>({
        await: () => [
            this.survivalClinicalDataGroupByUniquePatientKey,
            this.activePatientKeysNotOverlapRemoved,
            this.survivalClinicalAttributesPrefix,
            this.survivalEntryMonths,
        ],
        invoke: () => {
            return Promise.resolve(
                _.reduce(
                    this.survivalClinicalAttributesPrefix.result!,
                    (acc, key) => {
                        acc[key] = getPatientSurvivals(
                            this.survivalClinicalDataGroupByUniquePatientKey
                                .result!,
                            this.activePatientKeysNotOverlapRemoved.result!,
                            `${key}_STATUS`,
                            `${key}_MONTHS`,
                            s => getSurvivalStatusBoolean(s, key),
                            undefined
                        );
                        return acc;
                    },
                    {} as { [prefix: string]: PatientSurvival[] }
                )
            );
        },
    });

    readonly patientSurvivals = remoteData<{
        [prefix: string]: PatientSurvival[];
    }>({
        await: () => [
            this.survivalClinicalDataGroupByUniquePatientKey,
            this.activePatientKeysNotOverlapRemoved,
            this.survivalClinicalAttributesPrefix,
            this.survivalEntryMonths,
        ],
        invoke: () => {
            return Promise.resolve(
                _.reduce(
                    this.survivalClinicalAttributesPrefix.result!,
                    (acc, key) => {
                        acc[key] = getPatientSurvivals(
                            this.survivalClinicalDataGroupByUniquePatientKey
                                .result!,
                            this.activePatientKeysNotOverlapRemoved.result!,
                            `${key}_STATUS`,
                            `${key}_MONTHS`,
                            s => getSurvivalStatusBoolean(s, key),
                            // Currently, left truncation is only appliable for Overall Survival data
                            this.adjustForLeftTruncation && key === 'OS'
                                ? this.survivalEntryMonths.result
                                : undefined
                        );
                        return acc;
                    },
                    {} as { [prefix: string]: PatientSurvival[] }
                )
            );
        },
    });

    readonly uidToGroup = remoteData({
        await: () => [this._originalGroups],
        invoke: () => {
            return Promise.resolve(
                _.keyBy(this._originalGroups.result!, group => group.uid)
            );
        },
    });

    public readonly clinicalDataEnrichments = remoteData(
        {
            await: () => [this.activeGroups],
            invoke: () => {
                if (this.clinicalTabUnavailable) {
                    return Promise.resolve([]);
                }
                let groups: Group[] = _.map(this.activeGroups.result, group => {
                    const sampleIdentifiers = [];
                    for (const studySpec of group.studies) {
                        const studyId = studySpec.id;
                        for (const sampleId of studySpec.samples) {
                            sampleIdentifiers.push({
                                studyId,
                                sampleId,
                            });
                        }
                    }
                    return {
                        name: group.nameWithOrdinal || group.uid,
                        sampleIdentifiers: sampleIdentifiers,
                    };
                });
                if (groups.length > 1) {
                    return internalClient.fetchClinicalEnrichmentsUsingPOST({
                        groupFilter: {
                            groups: groups,
                        },
                    });
                } else {
                    return Promise.resolve([]);
                }
            },
            onError: () => {
                // suppress failsafe error handler
            },
        },
        []
    );

    readonly clinicalDataEnrichmentsWithQValues = remoteData<
        ClinicalDataEnrichmentWithQ[]
    >(
        {
            await: () => [this.clinicalDataEnrichments],
            invoke: () => {
                const clinicalDataEnrichments = this.clinicalDataEnrichments
                    .result!;
                const sortedByPvalue = _.sortBy(
                    clinicalDataEnrichments,
                    c => c.pValue
                );
                const qValues = calculateQValues(
                    sortedByPvalue.map(c => c.pValue)
                );
                qValues.forEach((qValue, index) => {
                    (sortedByPvalue[
                        index
                    ] as ClinicalDataEnrichmentWithQ).qValue = qValue;
                });
                return Promise.resolve(
                    sortedByPvalue as ClinicalDataEnrichmentWithQ[]
                );
            },
            onError: () => {
                // suppress failsafe error handler
            },
        },
        []
    );

    readonly activeStudyIdToStudy = remoteData(
        {
            await: () => [this.studies, this.activeStudyIds],
            invoke: () =>
                Promise.resolve(
                    _.keyBy(
                        _.filter(this.studies.result, study =>
                            this.activeStudyIds.result!.includes(study.studyId)
                        ),
                        x => x.studyId
                    )
                ),
        },
        {}
    );

    readonly survivalXAxisLabelGroupByPrefix = remoteData({
        await: () => [
            this.allSurvivalAttributes,
            this.survivalClinicalAttributesPrefix,
        ],
        invoke: () => {
            const survivalXAxisLabelGroupByPrefix = _.reduce(
                this.survivalClinicalAttributesPrefix.result!,
                (acc, prefix) => {
                    const clinicalAttributeId = `${prefix}_MONTHS`;
                    const clinicalAttributes = _.filter(
                        this.allSurvivalAttributes.result,
                        attr => attr.clinicalAttributeId === clinicalAttributeId
                    );
                    if (clinicalAttributes.length > 0) {
                        const xLabels = clinicalAttributes.map(
                            attr => attr.displayName
                        );
                        // find the most common text as the label
                        // findFirstMostCommonElt require a sorted array as the input
                        acc[prefix] = findFirstMostCommonElt(xLabels.sort())!;
                    }
                    return acc;
                },
                {} as { [prefix: string]: string }
            );
            return Promise.resolve(survivalXAxisLabelGroupByPrefix);
        },
    });

    readonly survivalDescriptions = remoteData({
        await: () => [
            this.allSurvivalAttributes,
            this.activeStudyIdToStudy,
            this.survivalClinicalAttributesPrefix,
        ],
        invoke: () => {
            const survivalDescriptions = _.reduce(
                this.survivalClinicalAttributesPrefix.result!,
                (acc, prefix) => {
                    const clinicalAttributeId = `${prefix}_STATUS`;
                    const clinicalAttributes = _.filter(
                        this.allSurvivalAttributes.result,
                        attr => attr.clinicalAttributeId === clinicalAttributeId
                    );
                    if (clinicalAttributes.length > 0) {
                        clinicalAttributes.map(attr => {
                            if (!acc[prefix]) {
                                acc[prefix] = [];
                            }
                            acc[prefix].push({
                                studyName: this.activeStudyIdToStudy.result[
                                    attr.studyId
                                ].name,
                                description: attr.description,
                                displayName: attr.displayName,
                                chartType: _.keys(
                                    this.customSurvivalPlots
                                ).includes(prefix)
                                    ? SurvivalChartType.CUSTOM
                                    : SurvivalChartType.PREDEFINED,
                            } as ISurvivalDescription & { chartType: SurvivalChartType });
                        });
                    }
                    return acc;
                },
                {} as {
                    [prefix: string]: (ISurvivalDescription & {
                        chartType: SurvivalChartType;
                    })[];
                }
            );
            return Promise.resolve(survivalDescriptions);
        },
    });

    @autobind
    public getGroupsDownloadDataPromise() {
        return new Promise<string>(resolve => {
            onMobxPromise<any>(
                [this._originalGroups, this.samples, this.sampleKeyToGroups],
                (
                    groupsContainingSampleAndMolecularProfileIdentifiers: ComparisonGroup[],
                    samples: Sample[],
                    sampleKeyToGroups: {
                        [uniqueSampleKey: string]: {
                            [groupUid: string]: boolean;
                        };
                    }
                ) => {
                    resolve(
                        getGroupsDownloadData(
                            samples,
                            groupsContainingSampleAndMolecularProfileIdentifiers,
                            sampleKeyToGroups
                        )
                    );
                }
            );
        });
    }

    readonly molecularProfilesInStudies = remoteData<MolecularProfile[]>(
        {
            await: () => [this.studies],
            invoke: () => {
                const studyIds = _.map(
                    this.studies.result,
                    (s: CancerStudy) => s.studyId
                );
                return client.fetchMolecularProfilesUsingPOST({
                    molecularProfileFilter: {
                        studyIds: studyIds,
                    } as MolecularProfileFilter,
                });
            },
        },
        []
    );

    readonly customDriverAnnotationProfiles = remoteData<MolecularProfile[]>(
        {
            await: () => [this.molecularProfilesInStudies],
            invoke: () => {
                return Promise.resolve(
                    _.filter(
                        this.molecularProfilesInStudies.result,
                        (molecularProfile: MolecularProfile) =>
                            // discrete CNA's
                            (molecularProfile.molecularAlterationType ===
                                AlterationTypeConstants.COPY_NUMBER_ALTERATION &&
                                molecularProfile.datatype ===
                                    DataTypeConstants.DISCRETE) ||
                            // mutations
                            molecularProfile.molecularAlterationType ===
                                AlterationTypeConstants.MUTATION_EXTENDED ||
                            // structural variants
                            molecularProfile.molecularAlterationType ===
                                AlterationTypeConstants.STRUCTURAL_VARIANT
                    )
                );
            },
        },
        []
    );

    readonly customDriverAnnotationReport = remoteData<IDriverAnnotationReport>(
        {
            await: () => [this.customDriverAnnotationProfiles],
            invoke: async () => {
                const molecularProfileIds = _.map(
                    this.customDriverAnnotationProfiles.result,
                    (p: MolecularProfile) => p.molecularProfileId
                );
                const report = await internalClient.fetchAlterationDriverAnnotationReportUsingPOST(
                    {
                        molecularProfileIds,
                    }
                );
                return {
                    ...report,
                    hasCustomDriverAnnotations:
                        report.hasBinary || report.tiers.length > 0,
                };
            },
            onResult: result => {
                initializeCustomDriverAnnotationSettings(
                    result!,
                    this.driverAnnotationSettings,
                    this.driverAnnotationSettings.customTiersDefault
                );
            },
            default: {
                hasBinary: false,
                tiers: [],
            },
        }
    );

    @computed get showDriverAnnotationMenuSection() {
        return !!(
            this.customDriverAnnotationReport.isComplete &&
            this.customDriverAnnotationReport.result!.hasBinary &&
            getServerConfig()
                .oncoprint_custom_driver_annotation_binary_menu_label &&
            getServerConfig()
                .oncoprint_custom_driver_annotation_tiers_menu_label
        );
    }

    @computed get showDriverTierAnnotationMenuSection() {
        return !!(
            this.customDriverAnnotationReport.isComplete &&
            this.customDriverAnnotationReport.result!.tiers.length > 0 &&
            getServerConfig()
                .oncoprint_custom_driver_annotation_binary_menu_label &&
            getServerConfig()
                .oncoprint_custom_driver_annotation_tiers_menu_label
        );
    }

    @computed get selectedDriverTiers() {
        return this.allDriverTiers.filter(tier =>
            this.driverAnnotationSettings.driverTiers.get(tier)
        );
    }

    @computed get allDriverTiers() {
        return this.customDriverAnnotationReport.isComplete
            ? this.customDriverAnnotationReport.result!.tiers
            : [];
    }

    @computed get selectedDriverTiersMap() {
        return buildSelectedDriverTiersMap(
            this.selectedDriverTiers || [],
            this.customDriverAnnotationReport.result!.tiers
        );
    }

    @computed get hasMutationEnrichmentData(): boolean {
        return (
            this.mutationEnrichmentProfiles.isComplete &&
            this.mutationEnrichmentProfiles.result!.length > 0
        );
    }

    @computed get hasCnaEnrichmentData(): boolean {
        return (
            this.copyNumberEnrichmentProfiles.isComplete &&
            this.copyNumberEnrichmentProfiles.result!.length > 0
        );
    }

    @computed get hasStructuralVariantData(): boolean {
        return (
            this.structuralVariantEnrichmentProfiles.isComplete &&
            this.structuralVariantEnrichmentProfiles.result!.length > 0
        );
    }

    @action.bound
    public addSurvivalRequest(
        startClinicalEventType: string,
        startEventPosition: 'FIRST' | 'LAST',
        startClinicalEventAttributes: ClinicalEventDataWithKey[],
        endClinicalEventType: string,
        endEventPosition: 'FIRST' | 'LAST',
        endClinicalEventAttributes: ClinicalEventDataWithKey[],
        censoredClinicalEventType: string,
        censoredEventPosition: 'FIRST' | 'LAST',
        censoredClinicalEventAttributes: ClinicalEventDataWithKey[],
        name: string
    ) {
        this.customSurvivalPlots[name] = {
            name,
            endEventRequestIdentifier: {
                clinicalEventRequests: [
                    {
                        attributes: endClinicalEventAttributes.map(x => ({
                            key: x.key,
                            value: x.value,
                        })),
                        eventType: endClinicalEventType,
                    },
                ],
                position: endEventPosition,
            },
            startEventRequestIdentifier: {
                clinicalEventRequests: [
                    {
                        attributes: startClinicalEventAttributes.map(x => ({
                            key: x.key,
                            value: x.value,
                        })),
                        eventType: startClinicalEventType,
                    },
                ],
                position: startEventPosition,
            },
            censoredEventRequestIdentifier: {
                clinicalEventRequests: [
                    {
                        attributes: censoredClinicalEventAttributes.map(x => ({
                            key: x.key,
                            value: x.value,
                        })),
                        eventType: censoredClinicalEventType,
                    },
                ],
                position: censoredEventPosition,
            },
        };

        if (!this.customSurvivalDataPromises.hasOwnProperty(name)) {
            this.customSurvivalDataPromises[name] = remoteData<ClinicalData[]>({
                await: () => {
                    return [this.activeSamplesNotOverlapRemoved];
                },
                invoke: async () => {
                    const attr = this.customSurvivalPlots[name];
                    let censoredEventRequestIdentifier = toJS(
                        attr.censoredEventRequestIdentifier!
                    );
                    censoredEventRequestIdentifier.clinicalEventRequests =
                        censoredClinicalEventType !== 'any'
                            ? censoredEventRequestIdentifier.clinicalEventRequests
                            : [];

                    const survivalRequest = {
                        attributeIdPrefix: name,
                        startEventRequestIdentifier: attr.startEventRequestIdentifier!,
                        endEventRequestIdentifier: attr.endEventRequestIdentifier!,
                        censoredEventRequestIdentifier: censoredEventRequestIdentifier,
                        patientIdentifiers: this.activeSamplesNotOverlapRemoved.result!.map(
                            (s: any) => ({
                                patientId: s.patientId,
                                studyId: s.studyId,
                            })
                        ),
                    };
                    let result = await internalClient.fetchSurvivalDataUsingPOST(
                        {
                            survivalRequest,
                        }
                    );
                    return result;
                },
                onError: () => {},
                default: [],
            });
        }
    }

    @action.bound
    private loadCustomSurvivalCharts(): void {
        this.customSurvivalPlots = _.keyBy(
            this._session.result!.customSurvivalPlots || [],
            'name'
        );

        _.forEach(this.customSurvivalPlots, plot => {
            this.addSurvivalRequest(
                plot.startEventRequestIdentifier!.clinicalEventRequests[0]
                    .eventType,
                plot.startEventRequestIdentifier!.position,
                plot.startEventRequestIdentifier!.clinicalEventRequests[0]
                    .attributes as ClinicalEventDataWithKey[],
                plot.endEventRequestIdentifier!.clinicalEventRequests[0]
                    .eventType,
                plot.endEventRequestIdentifier!.position,
                plot.endEventRequestIdentifier!.clinicalEventRequests[0]
                    .attributes as ClinicalEventDataWithKey[],
                plot.censoredEventRequestIdentifier!.clinicalEventRequests[0]
                    .eventType,
                plot.censoredEventRequestIdentifier!.position,
                plot.censoredEventRequestIdentifier!.clinicalEventRequests[0]
                    .attributes as ClinicalEventDataWithKey[],
                plot.name || ''
            );
        });
    }
}
