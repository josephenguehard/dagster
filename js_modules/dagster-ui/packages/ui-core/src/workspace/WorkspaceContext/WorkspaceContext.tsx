import sortBy from 'lodash/sortBy';
import React, {useCallback, useContext, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useSetRecoilState} from 'recoil';

import {CODE_LOCATION_STATUS_QUERY, LOCATION_WORKSPACE_QUERY} from './WorkspaceQueries';
import {
  CodeLocationStatusQuery,
  CodeLocationStatusQueryVariables,
  CodeLocationStatusQueryVersion,
  LocationStatusEntryFragment,
  LocationWorkspaceQuery,
  LocationWorkspaceQueryVariables,
  LocationWorkspaceQueryVersion,
  WorkspaceLocationNodeFragment,
  WorkspaceScheduleFragment,
  WorkspaceSensorFragment,
} from './types/WorkspaceQueries.types';
import {
  DagsterRepoOption,
  SetVisibleOrHiddenFn,
  locationWorkspaceKey,
  repoLocationToRepos,
  useVisibleRepos,
} from './util';
import {useApolloClient} from '../../apollo-client';
import {AppContext} from '../../app/AppContext';
import {useRefreshAtInterval} from '../../app/QueryRefresh';
import {PythonErrorFragment} from '../../app/types/PythonErrorFragment.types';
import {useUpdatingRef} from '../../hooks/useUpdatingRef';
import {codeLocationStatusAtom} from '../../nav/useCodeLocationsStatus';
import {
  useClearCachedData,
  useGetCachedData,
  useGetData,
  useIndexedDBCachedQuery,
} from '../../search/useIndexedDBCachedQuery';

export const CODE_LOCATION_STATUS_QUERY_KEY = '/CodeLocationStatusQuery';

export type WorkspaceRepositorySensor = WorkspaceSensorFragment;
export type WorkspaceRepositorySchedule = WorkspaceScheduleFragment;
export type WorkspaceRepositoryLocationNode = WorkspaceLocationNodeFragment;

type WorkspaceState = {
  loading: boolean;
  locationEntries: WorkspaceRepositoryLocationNode[];
  locationStatuses: Record<string, LocationStatusEntryFragment>;
  allRepos: DagsterRepoOption[];
  visibleRepos: DagsterRepoOption[];
  data: Record<string, WorkspaceLocationNodeFragment | PythonErrorFragment>;
  refetch: () => Promise<LocationWorkspaceQuery[]>;

  toggleVisible: SetVisibleOrHiddenFn;
  setVisible: SetVisibleOrHiddenFn;
  setHidden: SetVisibleOrHiddenFn;
};

export const WorkspaceContext = React.createContext<WorkspaceState>(
  new Error('WorkspaceContext should never be uninitialized') as any,
);

export const HIDDEN_REPO_KEYS = 'dagster.hidden-repo-keys';

export const WorkspaceProvider = ({children}: {children: React.ReactNode}) => {
  const {localCacheIdPrefix} = useContext(AppContext);
  const codeLocationStatusQueryResult = useIndexedDBCachedQuery<
    CodeLocationStatusQuery,
    CodeLocationStatusQueryVariables
  >({
    query: CODE_LOCATION_STATUS_QUERY,
    version: CodeLocationStatusQueryVersion,
    key: `${localCacheIdPrefix}${CODE_LOCATION_STATUS_QUERY_KEY}`,
  });
  if (typeof jest === 'undefined') {
    // Only do this outside of jest for now so that we don't need to add RecoilRoot around everything...
    // we will switch to jotai at some point instead... which doesnt require a
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const setCodeLocationStatusAtom = useSetRecoilState(codeLocationStatusAtom);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useLayoutEffect(() => {
      if (codeLocationStatusQueryResult.data) {
        setCodeLocationStatusAtom(codeLocationStatusQueryResult.data);
      }
    }, [codeLocationStatusQueryResult.data, setCodeLocationStatusAtom]);
  }
  indexedDB.deleteDatabase('indexdbQueryCache:RootWorkspace');

  const fetch = codeLocationStatusQueryResult.fetch;
  useRefreshAtInterval({
    refresh: useCallback(async () => {
      return await fetch();
    }, [fetch]),
    intervalMs: 5000,
    leading: true,
  });

  const {data: codeLocationStatusData} = codeLocationStatusQueryResult;

  const locationStatuses = useMemo(
    () => getLocations(codeLocationStatusData),
    [codeLocationStatusData],
  );
  const prevLocationStatuses = useRef<typeof locationStatuses>({});

  const didInitiateFetchFromCache = useRef(false);
  const [didLoadStatusData, setDidLoadStatusData] = useState(false);

  const [locationEntriesData, setLocationEntriesData] = React.useState<
    Record<string, WorkspaceLocationNodeFragment | PythonErrorFragment>
  >({});

  const getCachedData = useGetCachedData();
  const getData = useGetData();
  const clearCachedData = useClearCachedData();

  useLayoutEffect(() => {
    // Load data from the cache
    if (didInitiateFetchFromCache.current) {
      return;
    }
    didInitiateFetchFromCache.current = true;
    const allData: typeof locationEntriesData = {};
    new Promise(async (res) => {
      /**
       * 1. Load the cached code location status query
       * 2. Load the cached data for those locations
       * 3. Set the cached data to `locationsData` state
       * 4. Set prevLocations equal to these cached locations so that we can check if they
       *  have changed after the next call to codeLocationStatusQuery
       * 5. set didLoadCachedData to true to unblock the `locationsToFetch` memo so that it can compare
       *  the latest codeLocationStatusQuery result to what was in the cache.
       */
      const data = await getCachedData<CodeLocationStatusQuery>({
        key: `${localCacheIdPrefix}${CODE_LOCATION_STATUS_QUERY_KEY}`,
        version: CodeLocationStatusQueryVersion,
      });
      const cachedLocations = getLocations(data);
      const prevCachedLocations: typeof locationStatuses = {};

      await Promise.all([
        ...Object.values(cachedLocations).map(async (location) => {
          const locationData = await getCachedData<LocationWorkspaceQuery>({
            key: `${localCacheIdPrefix}${locationWorkspaceKey(location.name)}`,
            version: LocationWorkspaceQueryVersion,
          });
          const entry = locationData?.workspaceLocationEntryOrError;
          if (!entry) {
            return;
          }
          allData[location.name] = entry;

          if (entry.__typename === 'WorkspaceLocationEntry') {
            prevCachedLocations[location.name] = location;
          }
        }),
      ]);
      prevLocationStatuses.current = prevCachedLocations;
      res(void 0);
    }).then(() => {
      setDidLoadStatusData(true);
      setLocationEntriesData(allData);
    });
  }, [getCachedData, localCacheIdPrefix, locationStatuses]);

  const client = useApolloClient();

  const refetchLocation = useCallback(
    async (name: string) => {
      const locationData = await getData<LocationWorkspaceQuery, LocationWorkspaceQueryVariables>({
        client,
        query: LOCATION_WORKSPACE_QUERY,
        key: `${localCacheIdPrefix}${locationWorkspaceKey(name)}`,
        version: LocationWorkspaceQueryVersion,
        variables: {
          name,
        },
        bypassCache: true,
      });
      const entry = locationData.data?.workspaceLocationEntryOrError;
      if (entry) {
        setLocationEntriesData((locationsData) =>
          Object.assign({}, locationsData, {
            [name]: entry,
          }),
        );
      }
      return locationData;
    },
    [client, getData, localCacheIdPrefix],
  );

  const [isRefetching, setIsRefetching] = useState(false);

  const locationsToFetch = useMemo(() => {
    if (!didLoadStatusData) {
      return [];
    }
    if (isRefetching) {
      return [];
    }
    const toFetch = Object.values(locationStatuses).filter((loc) => {
      const prev = prevLocationStatuses.current?.[loc.name];
      const d = locationEntriesData[loc.name];
      const entry = d?.__typename === 'WorkspaceLocationEntry' ? d : null;
      return (
        prev?.versionKey !== loc.versionKey ||
        prev?.loadStatus !== loc.loadStatus ||
        entry?.loadStatus !== loc.loadStatus
      );
    });
    prevLocationStatuses.current = locationStatuses;
    return toFetch;
  }, [didLoadStatusData, isRefetching, locationStatuses, locationEntriesData]);

  useLayoutEffect(() => {
    if (!locationsToFetch.length) {
      return;
    }
    setIsRefetching(true);
    Promise.all(
      locationsToFetch.map(async (location) => {
        return await refetchLocation(location.name);
      }),
    ).then(() => {
      setIsRefetching(false);
    });
  }, [refetchLocation, locationsToFetch]);

  const locationsRemoved = useMemo(
    () =>
      Array.from(
        new Set([
          ...Object.values(prevLocationStatuses.current).filter(
            (loc) => loc && !locationStatuses[loc.name],
          ),
          ...Object.values(locationEntriesData).filter(
            (loc): loc is WorkspaceLocationNodeFragment =>
              loc && loc?.__typename === 'WorkspaceLocationEntry' && !locationStatuses[loc.name],
          ),
        ]),
      ),
    [locationStatuses, locationEntriesData],
  );

  useLayoutEffect(() => {
    if (!locationsRemoved.length) {
      return;
    }
    const copy = {...locationEntriesData};
    locationsRemoved.forEach((loc) => {
      delete copy[loc.name];
      clearCachedData({key: `${localCacheIdPrefix}${locationWorkspaceKey(loc.name)}`});
    });
    if (Object.keys(copy).length !== Object.keys(locationEntriesData).length) {
      setLocationEntriesData(copy);
    }
  }, [clearCachedData, localCacheIdPrefix, locationEntriesData, locationsRemoved]);

  const locationEntries = useMemo(
    () =>
      Object.values(locationEntriesData).filter(
        (entry): entry is WorkspaceLocationNodeFragment =>
          !!entry && entry.__typename === 'WorkspaceLocationEntry',
      ),
    [locationEntriesData],
  );

  const allRepos = React.useMemo(() => {
    let allRepos: DagsterRepoOption[] = [];

    allRepos = sortBy(
      locationEntries.reduce((accum, locationEntry) => {
        if (locationEntry.locationOrLoadError?.__typename !== 'RepositoryLocation') {
          return accum;
        }
        const repositoryLocation = locationEntry.locationOrLoadError;
        const reposForLocation = repoLocationToRepos(repositoryLocation);
        accum.push(...reposForLocation);
        return accum;
      }, [] as DagsterRepoOption[]),

      // Sort by repo location, then by repo
      (r) => `${r.repositoryLocation.name}:${r.repository.name}`,
    );

    return allRepos;
  }, [locationEntries]);

  const {visibleRepos, toggleVisible, setVisible, setHidden} = useVisibleRepos(allRepos);

  const locationsRef = useUpdatingRef(locationStatuses);

  const refetch = useCallback(async () => {
    return await Promise.all(
      Object.values(locationsRef.current).map(async (location) => {
        const result = await refetchLocation(location.name);
        return result.data;
      }),
    );
  }, [locationsRef, refetchLocation]);

  return (
    <WorkspaceContext.Provider
      value={{
        loading: !(
          didLoadStatusData &&
          Object.keys(locationStatuses).every((locationName) => locationEntriesData[locationName])
        ),
        locationEntries,
        locationStatuses,
        allRepos,
        visibleRepos,
        toggleVisible,
        setVisible,
        setHidden,

        data: locationEntriesData,
        refetch,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
};

function getLocations(d: CodeLocationStatusQuery | undefined | null) {
  const locations =
    d?.locationStatusesOrError?.__typename === 'WorkspaceLocationStatusEntries'
      ? d?.locationStatusesOrError.entries
      : [];

  return locations.reduce(
    (accum, loc) => {
      accum[loc.name] = loc;
      return accum;
    },
    {} as Record<string, (typeof locations)[0]>,
  );
}
