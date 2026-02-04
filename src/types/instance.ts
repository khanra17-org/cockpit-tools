export interface InstanceProfile {
  id: string;
  name: string;
  userDataDir: string;
  extraArgs: string;
  bindAccountId?: string | null;
  createdAt: number;
  lastLaunchedAt?: number | null;
  lastPid?: number | null;
  running: boolean;
  isDefault?: boolean;
  followLocalAccount?: boolean;
}

export interface InstanceDefaults {
  rootDir: string;
  defaultUserDataDir: string;
}
