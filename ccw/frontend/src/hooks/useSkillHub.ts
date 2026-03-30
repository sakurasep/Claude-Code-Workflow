// ========================================
// Skill Hub Hooks
// ========================================
// React Query hooks for Skill Hub API

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchApi } from '@/lib/api';

// ============================================================================
// Types
// ============================================================================

export type CliType = 'claude' | 'codex';
export type SkillSource = 'remote' | 'local';

export interface RemoteSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  tags: string[];
  downloadUrl: string;
  readmeUrl?: string;
  homepage?: string;
  license?: string;
  updatedAt?: string;
}

export interface LocalSkill {
  id: string;
  name: string;
  folderName: string;
  description: string;
  version: string;
  author?: string;
  category?: string;
  tags?: string[];
  path: string;
  source: 'local';
  updatedAt: string;
}

export interface InstalledSkill {
  id: string;
  name: string;
  folderName: string;
  version: string;
  installedAt: string;
  installedTo: CliType;
  source: SkillSource;
  originalId: string;
  updatesAvailable?: boolean;
  latestVersion?: string;
}

export interface RemoteSkillsResponse {
  success: boolean;
  data: RemoteSkill[];
  meta: {
    version: string;
    updated_at: string;
    source: 'github' | 'http' | 'local';
  };
  total: number;
  timestamp: string;
}

export interface LocalSkillsResponse {
  success: boolean;
  data: LocalSkill[];
  total: number;
  timestamp: string;
}

export interface InstalledSkillsResponse {
  success: boolean;
  data: InstalledSkill[];
  total: number;
  timestamp: string;
}

export interface SkillInstallRequest {
  skillId: string;
  cliType: CliType;
  source: SkillSource;
  customName?: string;
  downloadUrl?: string;
}

export interface SkillInstallResponse {
  success: boolean;
  message: string;
  installedPath?: string;
  error?: string;
}

export interface SkillCacheRequest {
  skillId: string;
  downloadUrl: string;
}

export interface SkillCacheResponse {
  success: boolean;
  message: string;
  path?: string;
  error?: string;
}

export interface SkillHubStats {
  remoteTotal: number;
  localTotal: number;
  installedTotal: number;
  updatesAvailable: number;
  claudeInstalled: number;
  codexInstalled: number;
}

// ============================================================================
// Query Keys
// ============================================================================

export const skillHubKeys = {
  all: ['skill-hub'] as const,
  remote: () => [...skillHubKeys.all, 'remote'] as const,
  local: () => [...skillHubKeys.all, 'local'] as const,
  installed: (checkUpdates?: boolean) => [...skillHubKeys.all, 'installed', checkUpdates] as const,
  updates: () => [...skillHubKeys.all, 'updates'] as const,
  stats: () => [...skillHubKeys.all, 'stats'] as const,
};

// ============================================================================
// Remote Skills Hook
// ============================================================================

/**
 * Fetch remote skills from GitHub/HTTP index
 */
export function useRemoteSkills(enabled = true) {
  return useQuery({
    queryKey: skillHubKeys.remote(),
    queryFn: () => fetchApi<RemoteSkillsResponse>('/api/skill-hub/remote'),
    enabled,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    select: (data) => ({
      skills: data.data,
      meta: data.meta,
      total: data.total,
    }),
  });
}

// ============================================================================
// Local Skills Hook
// ============================================================================

/**
 * Fetch local shared skills
 */
export function useLocalSkills(enabled = true) {
  return useQuery({
    queryKey: skillHubKeys.local(),
    queryFn: () => fetchApi<LocalSkillsResponse>('/api/skill-hub/local'),
    enabled,
    select: (data) => ({
      skills: data.data,
      total: data.total,
    }),
  });
}

// ============================================================================
// Installed Skills Hook
// ============================================================================

/**
 * Fetch installed skills from hub
 */
export function useInstalledSkills(options?: { checkUpdates?: boolean; enabled?: boolean }) {
  const { checkUpdates = false, enabled = true } = options || {};

  return useQuery({
    queryKey: skillHubKeys.installed(checkUpdates),
    queryFn: () => {
      const url = checkUpdates
        ? '/api/skill-hub/installed?checkUpdates=true'
        : '/api/skill-hub/installed';
      return fetchApi<InstalledSkillsResponse>(url);
    },
    enabled,
    select: (data) => ({
      skills: data.data,
      total: data.total,
    }),
  });
}

// ============================================================================
// Updates Check Hook
// ============================================================================

/**
 * Check for available updates
 */
export function useSkillHubUpdates(enabled = true) {
  return useQuery({
    queryKey: skillHubKeys.updates(),
    queryFn: () => fetchApi<InstalledSkillsResponse>('/api/skill-hub/updates'),
    enabled,
    staleTime: 60 * 1000, // 1 minute
    select: (data) => ({
      updates: data.data,
      total: data.total,
    }),
  });
}

// ============================================================================
// Install Skill Mutation
// ============================================================================

/**
 * Install skill mutation
 */
export function useInstallSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: SkillInstallRequest) =>
      fetchApi<SkillInstallResponse>('/api/skill-hub/install', {
        method: 'POST',
        body: JSON.stringify(request),
      }),
    onSuccess: () => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: skillHubKeys.installed() });
      queryClient.invalidateQueries({ queryKey: skillHubKeys.updates() });
      queryClient.invalidateQueries({ queryKey: skillHubKeys.stats() });
    },
  });
}

// ============================================================================
// Cache Skill Mutation
// ============================================================================

/**
 * Cache remote skill mutation
 */
export function useCacheSkill() {
  return useMutation({
    mutationFn: (request: SkillCacheRequest) =>
      fetchApi<SkillCacheResponse>('/api/skill-hub/cache', {
        method: 'POST',
        body: JSON.stringify(request),
      }),
  });
}

// ============================================================================
// Uninstall Skill Mutation
// ============================================================================

/**
 * Uninstall skill mutation
 */
export function useUninstallSkill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ skillId, cliType }: { skillId: string; cliType: CliType }) =>
      fetchApi<{ success: boolean; message: string }>(`/api/skill-hub/installed/${skillId}`, {
        method: 'DELETE',
        body: JSON.stringify({ cliType }),
      }),
    onSuccess: () => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: skillHubKeys.installed() });
      queryClient.invalidateQueries({ queryKey: skillHubKeys.updates() });
      queryClient.invalidateQueries({ queryKey: skillHubKeys.stats() });
    },
  });
}

// ============================================================================
// Stats Hook
// ============================================================================

/**
 * Get skill hub statistics
 * Combines data from multiple endpoints
 */
export function useSkillHubStats(enabled = true) {
  const { data: remoteData } = useRemoteSkills(enabled);
  const { data: localData } = useLocalSkills(enabled);
  const { data: installedData } = useInstalledSkills({ checkUpdates: true, enabled });

  return useQuery({
    queryKey: skillHubKeys.stats(),
    queryFn: (): SkillHubStats => {
      const installed = installedData?.skills || [];
      const updatesAvailable = installed.filter(s => s.updatesAvailable).length;
      const claudeInstalled = installed.filter(s => s.installedTo === 'claude').length;
      const codexInstalled = installed.filter(s => s.installedTo === 'codex').length;

      return {
        remoteTotal: remoteData?.total || 0,
        localTotal: localData?.total || 0,
        installedTotal: installed.length,
        updatesAvailable,
        claudeInstalled,
        codexInstalled,
      };
    },
    enabled: enabled && !!remoteData && !!localData && !!installedData,
    staleTime: 30 * 1000, // 30 seconds
  });
}

// ============================================================================
// Combined Hooks
// ============================================================================

/**
 * Combined hook for all skill hub data
 */
export function useSkillHub(enabled = true) {
  const remote = useRemoteSkills(enabled);
  const local = useLocalSkills(enabled);
  const installed = useInstalledSkills({ checkUpdates: true, enabled });
  const stats = useSkillHubStats(enabled && remote.isSuccess && local.isSuccess && installed.isSuccess);

  const isLoading = remote.isLoading || local.isLoading || installed.isLoading;
  const isError = remote.isError || local.isError || installed.isError;
  const isFetching = remote.isFetching || local.isFetching || installed.isFetching;

  return {
    remote,
    local,
    installed,
    stats,
    isLoading,
    isError,
    isFetching,
    refetchAll: () => {
      remote.refetch();
      local.refetch();
      installed.refetch();
    },
  };
}
