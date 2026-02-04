import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Play,
  Pencil,
  Trash2,
  Terminal,
  FolderOpen,
  Square,
  ChevronDown,
  X,
  Search,
} from 'lucide-react';
import { confirm as confirmDialog, open } from '@tauri-apps/plugin-dialog';
import md5 from 'blueimp-md5';
import { InstanceProfile } from '../types/instance';
import { FileCorruptedModal, parseFileCorruptedError, type FileCorruptedError } from './FileCorruptedModal';
import type { InstanceStoreState } from '../stores/createInstanceStore';

type MessageState = { text: string; tone?: 'error' };
type RestartStrategy = 'safe' | 'force';
type AccountLike = { id: string; email: string };

interface InstancesManagerProps<TAccount extends AccountLike> {
  instanceStore: InstanceStoreState;
  accounts: TAccount[];
  fetchAccounts: () => Promise<void>;
  renderAccountQuotaPreview: (account: TAccount) => ReactNode;
  getAccountSearchText?: (account: TAccount) => string;
  restartStrategyStorageKey?: string;
  restartStrategyMode?: 'antigravity' | 'codex';
}

const hashDirName = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return md5(trimmed).substring(0, 16);
};

const joinPath = (root: string, name: string) => {
  if (!root) return name;
  const sep = root.includes('\\') ? '\\' : '/';
  if (root.endsWith(sep)) return `${root}${name}`;
  return `${root}${sep}${name}`;
};

export function InstancesManager<TAccount extends AccountLike>({
  instanceStore,
  accounts,
  fetchAccounts,
  renderAccountQuotaPreview,
  getAccountSearchText,
  restartStrategyStorageKey = 'instancesRestartStrategy',
  restartStrategyMode = 'antigravity',
}: InstancesManagerProps<TAccount>) {
  const { t } = useTranslation();
  const {
    instances,
    defaults,
    loading,
    error,
    fetchInstances,
    refreshInstances,
    fetchDefaults,
    createInstance,
    updateInstance,
    deleteInstance,
    startInstance,
    stopInstance,
    forceStopInstance,
    openInstanceWindow,
    closeAllInstances,
  } = instanceStore;

  const [message, setMessage] = useState<MessageState | null>(null);
  const [fileCorruptedError, setFileCorruptedError] = useState<FileCorruptedError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openInlineMenuId, setOpenInlineMenuId] = useState<string | null>(null);
  const [runningNoticeInstance, setRunningNoticeInstance] = useState<InstanceProfile | null>(null);
  const [showStrategyModal, setShowStrategyModal] = useState(false);
  const [restartStrategy, setRestartStrategy] = useState<RestartStrategy>(() => {
    const saved = localStorage.getItem(restartStrategyStorageKey);
    return saved === 'force' ? 'force' : 'safe';
  });
  const [pendingStrategy, setPendingStrategy] = useState<RestartStrategy>('safe');
  const [restartingAll, setRestartingAll] = useState(false);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<InstanceProfile | null>(null);
  const [formName, setFormName] = useState('');
  const [formPath, setFormPath] = useState('');
  const [formExtraArgs, setFormExtraArgs] = useState('');
  const [formBindAccountId, setFormBindAccountId] = useState<string>('');
  const [formCopySourceInstanceId, setFormCopySourceInstanceId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const formErrorRef = useRef<HTMLDivElement | null>(null);
  const [formErrorTick, setFormErrorTick] = useState(0);
  const [pathAuto, setPathAuto] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    fetchDefaults();
    fetchInstances();
    fetchAccounts();
  }, [fetchDefaults, fetchInstances, fetchAccounts]);

  useEffect(() => {
    if (!error) return;
    const corrupted = parseFileCorruptedError(error);
    if (corrupted) {
      setFileCorruptedError(corrupted);
    } else {
      setMessage({ text: String(error), tone: 'error' });
    }
  }, [error]);

  useEffect(() => {
    localStorage.setItem(restartStrategyStorageKey, restartStrategy);
  }, [restartStrategy, restartStrategyStorageKey]);

  useEffect(() => {
    if (!formError || !showModal) return;
    formErrorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [formError, formErrorTick, showModal]);

  const sortedInstances = useMemo(
    () =>
      [...instances].sort((a, b) => {
        if (a.isDefault && !b.isDefault) return -1;
        if (!a.isDefault && b.isDefault) return 1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      }),
    [instances],
  );

  const defaultInstanceId = useMemo(() => {
    const defaultInstance = instances.find((item) => item.isDefault);
    return defaultInstance?.id || '__default__';
  }, [instances]);

  const filteredInstances = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sortedInstances;
    return sortedInstances.filter((instance) => {
      const displayName = instance.isDefault ? t('instances.defaultName', '默认实例') : instance.name || '';
      const account = instance.bindAccountId
        ? accounts.find((item) => item.id === instance.bindAccountId) || null
        : null;
      const accountText = account
        ? getAccountSearchText
          ? getAccountSearchText(account)
          : account.email
        : '';
      const haystack = [displayName, accountText, instance.userDataDir || ''].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [accounts, getAccountSearchText, searchQuery, sortedInstances, t]);

  const defaultRoot = defaults?.rootDir ?? '';

  const buildDefaultPath = (name: string) => {
    if (!defaultRoot) return '';
    const segment = hashDirName(name);
    if (!segment) return defaultRoot;
    return joinPath(defaultRoot, segment);
  };

  useEffect(() => {
    if (editing || !pathAuto || !defaultRoot) return;
    const nextPath = buildDefaultPath(formName);
    if (nextPath && nextPath !== formPath) {
      setFormPath(nextPath);
    }
  }, [defaultRoot, editing, formName, pathAuto]);

  const resetForm = (showRoot = false) => {
    setFormName('');
    setFormPath(showRoot && defaultRoot ? defaultRoot : '');
    setFormExtraArgs('');
    setFormBindAccountId('');
    setFormCopySourceInstanceId(defaultInstanceId);
    setFormError(null);
    setPathAuto(true);
  };

  const openCreateModal = () => {
    resetForm(true);
    setEditing(null);
    setShowModal(true);
  };

  useEffect(() => {
    if (!showModal || editing) return;
    if (!formCopySourceInstanceId) {
      setFormCopySourceInstanceId(defaultInstanceId);
    }
  }, [defaultInstanceId, editing, formCopySourceInstanceId, showModal]);

  const openEditModal = (instance: InstanceProfile) => {
    setEditing(instance);
    setFormName(instance.isDefault ? t('instances.defaultName', '默认实例') : instance.name || '');
    setFormPath(instance.userDataDir || '');
    setFormExtraArgs(instance.extraArgs || '');
    setFormBindAccountId(instance.bindAccountId || '');
    setFormError(null);
    setPathAuto(false);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    resetForm();
    setEditing(null);
  };

  const handleNameChange = (value: string) => {
    setFormName(value);
    if (!editing && defaultRoot) {
      const nextPath = buildDefaultPath(value);
      if (nextPath) {
        setFormPath(nextPath);
      }
    }
  };

  const handleSelectPath = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: defaultRoot || undefined,
      });
      if (selected && typeof selected === 'string') {
        setFormPath(selected);
      }
    } catch (e) {
      setMessage({ text: String(e), tone: 'error' });
    }
  };

  const handleSubmit = async () => {
    setFormError(null);
    setMessage(null);
    const isEditingDefault = Boolean(editing?.isDefault);

    if (!isEditingDefault) {
      if (!formName.trim()) {
        setFormError(t('instances.form.nameRequired', '请输入实例名称'));
        setFormErrorTick((prev) => prev + 1);
        return;
      }
      if (!formPath.trim()) {
        setFormError(t('instances.form.pathRequired', '请选择实例目录'));
        setFormErrorTick((prev) => prev + 1);
        return;
      }
    }

    if (!editing && !formCopySourceInstanceId) {
      setFormError(t('instances.form.copySourceRequired', '请选择复制来源实例'));
      setFormErrorTick((prev) => prev + 1);
      return;
    }

    if (!formBindAccountId) {
      setFormError(t('instances.form.bindRequired', '请选择要绑定的账号'));
      setFormErrorTick((prev) => prev + 1);
      return;
    }

    try {
      if (editing) {
        setActionLoading(editing.id);
        const updatePayload: {
          instanceId: string;
          name?: string;
          extraArgs?: string;
          bindAccountId?: string | null;
          followLocalAccount?: boolean;
        } = {
          instanceId: editing.id,
          extraArgs: formExtraArgs,
        };
        if (!isEditingDefault) {
          updatePayload.name = formName.trim();
        }
        const nextBindId = formBindAccountId;
        updatePayload.bindAccountId = nextBindId;
        if (isEditingDefault) {
          updatePayload.followLocalAccount = false;
        }

        await updateInstance(updatePayload);
        setMessage({ text: t('instances.messages.updated', '实例已更新') });
      } else {
        setActionLoading('create');
        await createInstance({
          name: formName.trim(),
          userDataDir: formPath.trim(),
          extraArgs: formExtraArgs,
          bindAccountId: formBindAccountId,
          copySourceInstanceId: formCopySourceInstanceId,
        });
        setMessage({ text: t('instances.messages.created', '实例已创建') });
      }
      closeModal();
    } catch (e) {
      setFormError(String(e));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (instance: InstanceProfile) => {
    try {
      const confirmed = await confirmDialog(
        t('instances.delete.message', '确认删除实例 {{name}}？将移除配置并删除实例目录。', {
          name: instance.name,
        }),
        {
          title: t('instances.delete.title', '删除实例'),
          kind: 'warning',
        },
      );
      if (!confirmed) return;
    } catch {
      // ignore dialog errors
    }

    setActionLoading(instance.id);
    try {
      await deleteInstance(instance.id);
      setMessage({ text: t('instances.messages.deleted', '实例已删除') });
    } catch (e) {
      setMessage({ text: String(e), tone: 'error' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleStart = async (instance: InstanceProfile) => {
    if (instance.running) {
      setRunningNoticeInstance(instance);
      return;
    }
    setActionLoading(instance.id);
    try {
      await startInstance(instance.id);
      setMessage({ text: t('instances.messages.started', '实例已启动') });
    } catch (e) {
      setMessage({ text: String(e), tone: 'error' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleStop = async (instance: InstanceProfile) => {
    try {
      const confirmed = await confirmDialog(
        t('instances.stop.message', '将向实例进程发送终止信号（SIGTERM）强制关闭，可能导致未保存的数据丢失。确认继续？'),
        {
          title: t('instances.stop.title', '强制关闭实例'),
          kind: 'warning',
        },
      );
      if (!confirmed) return;
    } catch {
      // ignore dialog errors
    }

    setActionLoading(instance.id);
    try {
      await stopInstance(instance.id);
      setMessage({ text: t('instances.messages.stopped', '实例已关闭') });
    } catch (e) {
      setMessage({ text: String(e), tone: 'error' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleOpenRunningInstance = async () => {
    if (!runningNoticeInstance) return;
    try {
      await openInstanceWindow(runningNoticeInstance.id);
      setRunningNoticeInstance(null);
    } catch (e) {
      setMessage({ text: String(e), tone: 'error' });
    }
  };

  const handleForceRestart = async () => {
    if (!runningNoticeInstance) return;
    const target = runningNoticeInstance;
    setRunningNoticeInstance(null);
    setActionLoading(target.id);
    try {
      if (restartStrategy === 'safe') {
        await stopInstance(target.id);
        await startInstance(target.id);
      } else {
        await forceStopInstance(target.id);
        await startInstance(target.id);
      }
      setMessage({ text: t('instances.messages.started', '实例已启动') });
    } catch (e) {
      setMessage({ text: String(e), tone: 'error' });
    } finally {
      setRestartingAll(false);
      setActionLoading(null);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshInstances(), fetchAccounts()]);
    } catch (e) {
      setMessage({ text: String(e), tone: 'error' });
    } finally {
      setRefreshing(false);
    }
  };

  const handleStartAll = async () => {
    const confirmed = await confirmDialog(t('instances.bulkConfirm.startAll'), {
      title: t('common.confirm'),
      okLabel: t('common.confirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!confirmed) return;
    setBulkActionLoading(true);
    try {
      await refreshInstances();
      const stoppedIds = instances.filter((item) => !item.running).map((item) => item.id);
      if (stoppedIds.length === 0) {
        setMessage({ text: t('instances.messages.allAlreadyRunning', '所有实例已在运行') });
        return;
      }
      for (const id of stoppedIds) {
        await startInstance(id);
      }
      setMessage({ text: t('instances.messages.startedAll', '已启动所有未运行实例') });
    } catch (e) {
      setMessage({ text: String(e), tone: 'error' });
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleCloseAll = async () => {
    const confirmed = await confirmDialog(t('instances.bulkConfirm.stopAll'), {
      title: t('common.confirm'),
      okLabel: t('common.confirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!confirmed) return;
    setBulkActionLoading(true);
    try {
      await refreshInstances();
      await closeAllInstances();
      setMessage({ text: t('instances.messages.closedAll', '已关闭所有实例') });
    } catch (e) {
      setMessage({ text: String(e), tone: 'error' });
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleOpenStrategyModal = () => {
    setPendingStrategy(restartStrategy);
    setShowStrategyModal(true);
  };

  const handleConfirmStrategy = () => {
    setRestartStrategy(pendingStrategy);
    setShowStrategyModal(false);
  };

  const resolveAccount = (instance: InstanceProfile) => {
    if (!instance.bindAccountId) {
      return { account: null, missing: false };
    }
    const account = accounts.find((item) => item.id === instance.bindAccountId) || null;
    return { account, missing: !account };
  };

  const selectedCopySourceInstance = useMemo(() => {
    if (!formCopySourceInstanceId) {
      return instances.find((item) => item.id === defaultInstanceId) || null;
    }
    return instances.find((item) => item.id === formCopySourceInstanceId) || null;
  }, [defaultInstanceId, formCopySourceInstanceId, instances]);

  type AccountSelectProps = {
    value: string | null;
    onChange: (nextId: string | null) => void;
    allowUnbound?: boolean;
    allowFollowCurrent?: boolean;
    isFollowingCurrent?: boolean;
    onFollowCurrent?: () => void;
    onOpenChange?: (open: boolean) => void;
    disabled?: boolean;
    missing?: boolean;
    placeholder?: string;
  };

  const AccountSelect = ({
    value,
    onChange,
    allowUnbound = false,
    allowFollowCurrent = false,
    isFollowingCurrent = false,
    onFollowCurrent,
    onOpenChange,
    disabled = false,
    missing = false,
    placeholder,
  }: AccountSelectProps) => {
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      if (!open) return;
      const handleClick = (event: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
          setOpen(false);
          onOpenChange?.(false);
        }
      };
      document.addEventListener('mousedown', handleClick);
      return () => {
        document.removeEventListener('mousedown', handleClick);
      };
    }, [open]);

    useEffect(() => {
      if (disabled && open) {
        setOpen(false);
        onOpenChange?.(false);
      }
    }, [disabled, open]);

    const selectedAccount = accounts.find((item) => item.id === value) || null;
    const basePlaceholder =
      placeholder || (allowUnbound ? t('instances.form.unbound', '不绑定') : t('instances.form.selectAccount', '选择账号'));
    const selectedLabel = missing
      ? t('instances.quota.accountMissing', '账号不存在')
      : isFollowingCurrent
        ? selectedAccount?.email || t('instances.form.followCurrent', '跟随当前账号')
        : selectedAccount?.email || basePlaceholder;
    const selectedQuota = selectedAccount ? renderAccountQuotaPreview(selectedAccount) : null;

    return (
      <div className={`account-select ${disabled ? 'disabled' : ''}`} ref={menuRef}>
        <button
          type="button"
          className={`account-select-trigger ${open ? 'open' : ''}`}
          onClick={() => {
            if (disabled) return;
            setOpen((prev) => {
              const next = !prev;
              onOpenChange?.(next);
              return next;
            });
          }}
          disabled={disabled}
        >
          <span className="account-select-label" title={selectedLabel}>
            {selectedLabel}
          </span>
          <span className="account-select-meta">
            {selectedQuota}
            <ChevronDown size={14} />
          </span>
        </button>
        {open && !disabled && (
          <div className="account-select-menu">
            {allowFollowCurrent && (
              <button
                type="button"
                className={`account-select-item ${isFollowingCurrent ? 'active' : ''}`}
                onClick={() => {
                  if (onFollowCurrent) {
                    onFollowCurrent();
                  } else {
                    onChange(null);
                  }
                  setOpen(false);
                  onOpenChange?.(false);
                }}
              >
                <span className="account-select-email">
                  {t('instances.form.followCurrent', '跟随当前账号')}
                </span>
                {selectedAccount ? renderAccountQuotaPreview(selectedAccount) : null}
              </button>
            )}
            {allowUnbound && (
              <button
                type="button"
                className={`account-select-item ${!value && !isFollowingCurrent ? 'active' : ''}`}
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                  onOpenChange?.(false);
                }}
              >
                <span className="account-select-email muted">
                  {t('instances.form.unbound', '不绑定')}
                </span>
              </button>
            )}
            {accounts.map((account) => (
              <button
                type="button"
                key={account.id}
                className={`account-select-item ${value === account.id && !isFollowingCurrent ? 'active' : ''}`}
                onClick={() => {
                  onChange(account.id);
                  setOpen(false);
                  onOpenChange?.(false);
                }}
              >
                <span className="account-select-email" title={account.email}>
                  {account.email}
                </span>
                {renderAccountQuotaPreview(account)}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  type InstanceSelectProps = {
    value: string;
    onChange: (nextId: string) => void;
    disabled?: boolean;
  };

  const InstanceSelect = ({ value, onChange, disabled = false }: InstanceSelectProps) => {
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      if (!open) return;
      const handleClick = (event: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
          setOpen(false);
        }
      };
      document.addEventListener('mousedown', handleClick);
      return () => {
        document.removeEventListener('mousedown', handleClick);
      };
    }, [open]);

    useEffect(() => {
      if (disabled && open) {
        setOpen(false);
      }
    }, [disabled, open]);

    const selected = sortedInstances.find((item) => item.id === value)
      || sortedInstances.find((item) => item.isDefault)
      || null;
    const selectedLabel = selected
      ? selected.isDefault
        ? t('instances.defaultName', '默认实例')
        : selected.name || ''
      : value === '__default__'
        ? t('instances.defaultName', '默认实例')
        : t('instances.form.copySourcePlaceholder', '选择来源实例');

    return (
      <div className={`account-select ${disabled ? 'disabled' : ''}`} ref={menuRef}>
        <button
          type="button"
          className={`account-select-trigger ${open ? 'open' : ''}`}
          onClick={() => {
            if (disabled) return;
            setOpen((prev) => !prev);
          }}
          disabled={disabled}
        >
          <span className="account-select-label" title={selectedLabel}>
            {selectedLabel}
          </span>
          <span className="account-select-meta">
            <ChevronDown size={14} />
          </span>
        </button>
        {open && !disabled && (
          <div className="account-select-menu">
            {sortedInstances.length === 0 ? (
              <div className="account-select-item active">
                <span className="account-select-email muted">
                  {t('instances.defaultName', '默认实例')}
                </span>
              </div>
            ) : (
              sortedInstances.map((instance) => {
                const label = instance.isDefault
                  ? t('instances.defaultName', '默认实例')
                  : instance.name || '';
                return (
                  <button
                    type="button"
                    key={instance.id}
                    className={`account-select-item ${value === instance.id ? 'active' : ''}`}
                    onClick={() => {
                      onChange(instance.id);
                      setOpen(false);
                    }}
                    title={instance.userDataDir}
                  >
                    <span className="account-select-email">{label}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  };

  const handleFormAccountChange = (nextId: string | null) => {
    setFormBindAccountId(nextId ?? '');
  };

  const handleInlineBindChange = async (instance: InstanceProfile, nextId: string | null) => {
    if (!nextId) return;
    const sameSelection = (instance.bindAccountId || null) === nextId;
    if (sameSelection && !instance.followLocalAccount) return;
    setActionLoading(instance.id);
    try {
      await updateInstance({
        instanceId: instance.id,
        bindAccountId: nextId,
        followLocalAccount: instance.isDefault ? false : undefined,
      });
    } catch (e) {
      setMessage({ text: String(e), tone: 'error' });
    } finally {
      setActionLoading(null);
    }
  };

  const resolveRestartText = (codexKey: string, baseKey: string, fallback: string) => {
    if (restartStrategyMode === 'codex') {
      return t(codexKey, t(baseKey, fallback));
    }
    return t(baseKey, fallback);
  };

  return (
    <>
      {fileCorruptedError && (
        <FileCorruptedModal error={fileCorruptedError} onClose={() => setFileCorruptedError(null)} />
      )}

      <div className="toolbar instances-toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <Search size={16} className="search-icon" />
            <input
              type="text"
              placeholder={t('instances.search', '搜索实例')}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
        </div>
        <div className="toolbar-right">
          <button className="btn btn-primary" onClick={openCreateModal} title={t('instances.actions.create', '新建实例')}>
            <Plus size={16} />
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleStartAll}
            disabled={bulkActionLoading || restartingAll}
            title={t('instances.actions.startAll', '全部启动')}
          >
            <Play size={16} />
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleCloseAll}
            disabled={bulkActionLoading || restartingAll}
            title={t('instances.actions.stopAll', '全部关闭')}
          >
            <Square size={16} />
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleRefresh}
            disabled={refreshing || bulkActionLoading || restartingAll}
          >
            {t('instances.actions.refresh', '刷新')}
          </button>
        </div>
      </div>

      {message && (
        <div className={`action-message${message.tone ? ` ${message.tone}` : ''}`}>
          <span className="action-message-text">{message.text}</span>
          <button className="action-message-close" onClick={() => setMessage(null)} aria-label={t('common.close', '关闭')}>
            <X size={14} />
          </button>
        </div>
      )}

      {loading ? (
        <div className="loading-state">{t('common.loading', '加载中...')}</div>
      ) : sortedInstances.length === 0 ? (
        <div className="empty-state">
          <h3>{t('instances.empty.title', '还没有实例')}</h3>
          <p>{t('instances.empty.desc', '创建一个独立配置目录，快速开启多实例。')}</p>
          <button className="btn btn-primary" onClick={openCreateModal}>
            <Plus size={16} />
            {t('instances.actions.create', '新建实例')}
          </button>
        </div>
      ) : (
        <div className="instances-list">
          <div className="instances-list-header">
            <div>{t('instances.columns.instance', '实例')}</div>
            <div>{t('instances.columns.email', '账号')}</div>
            <div>PID</div>
            <div>{t('instances.columns.actions', '操作')}</div>
          </div>
          {filteredInstances.map((instance) => {
            const { missing: accountMissing } = resolveAccount(instance);
            return (
              <div
                className={`instance-item ${openInlineMenuId === instance.id ? 'dropdown-open' : ''}`}
                key={instance.id}
              >
                <div className="instance-main-info">
                  <div className="instance-title-row">
                    <span className="instance-name">
                      {instance.isDefault ? t('instances.defaultName', '默认实例') : instance.name}
                    </span>
                    <span
                      className={`instance-status ${
                        restartingAll ? 'restarting' : instance.running ? 'running' : 'stopped'
                      }`}
                    >
                      {restartingAll
                        ? t('instances.status.restarting', '重启中')
                        : instance.running
                          ? t('instances.status.running', '运行中')
                          : t('instances.status.stopped', '未运行')}
                    </span>
                  </div>
                  {instance.extraArgs?.trim() && (
                    <div className="instance-sub-info">
                      <span className="info-item" title={instance.extraArgs}>
                        <Terminal size={12} />
                        {t('instances.labels.argsPresent', '有参数')}
                      </span>
                    </div>
                  )}
                </div>

                <div className="instance-account">
                  <AccountSelect
                    value={instance.bindAccountId || null}
                    onChange={(nextId) => handleInlineBindChange(instance, nextId)}
                    disabled={actionLoading === instance.id}
                    missing={accountMissing}
                    placeholder={t('instances.labels.unbound', '未绑定')}
                    onOpenChange={(open) => {
                      setOpenInlineMenuId((prev) => (open ? instance.id : prev === instance.id ? null : prev));
                    }}
                  />
                </div>

                <div className="instance-pid">
                  <span className="pid-value">{instance.lastPid ?? '-'}</span>
                </div>

                <div className="instance-actions">
                  <button
                    className="icon-button"
                    title={t('instances.actions.start', '启动')}
                    onClick={() => handleStart(instance)}
                    disabled={actionLoading === instance.id || restartingAll || bulkActionLoading}
                  >
                    <Play size={16} />
                  </button>
                  <button
                    className="icon-button danger"
                    title={t('instances.actions.stop', '停止')}
                    onClick={() => handleStop(instance)}
                    disabled={!instance.running || actionLoading === instance.id || restartingAll || bulkActionLoading}
                  >
                    <Square size={16} />
                  </button>
                  <button
                    className="icon-button"
                    title={t('instances.actions.edit', '编辑')}
                    onClick={() => openEditModal(instance)}
                    disabled={actionLoading === instance.id || restartingAll || bulkActionLoading}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="icon-button danger"
                    title={t('common.delete', '删除')}
                    onClick={() => handleDelete(instance)}
                    disabled={instance.isDefault || actionLoading === instance.id || restartingAll || bulkActionLoading}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {runningNoticeInstance && (
        <div className="modal-overlay" onClick={() => setRunningNoticeInstance(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('instances.runningDialog.title', '实例已在运行')}</h2>
              <button
                className="modal-close"
                onClick={() => setRunningNoticeInstance(null)}
                aria-label={t('common.close', '关闭')}
              >
                <X />
              </button>
            </div>
            <div className="modal-body">
              <p className="form-hint">
                {t('instances.runningDialog.desc', '实例已在运行中，可立马前往或按当前策略重启。')}
              </p>
              <p className="form-hint">
                {t('instances.runningDialog.current', '当前策略：{{name}}', {
                  name:
                    restartStrategy === 'safe'
                      ? t('instances.restartStrategy.safe.title', '安全重启（推荐）')
                      : t('instances.restartStrategy.force.title', '强制重启'),
                })}
              </p>
              <div className="form-group">
                <label>{t('instances.runningDialog.pathLabel', '实例目录')}</label>
                <input className="form-input" value={runningNoticeInstance.userDataDir} disabled />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={handleOpenRunningInstance}>
                {t('instances.runningDialog.go', '立马前往')}
              </button>
              <button className="btn btn-danger" onClick={handleForceRestart}>
                {t('instances.runningDialog.restart', '关闭并重启')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showStrategyModal && (
        <div className="modal-overlay" onClick={() => setShowStrategyModal(false)}>
          <div className="modal restart-strategy-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('instances.restartStrategy.title', '重启策略')}</h2>
              <button
                className="modal-close"
                onClick={() => setShowStrategyModal(false)}
                aria-label={t('common.close', '关闭')}
              >
                <X />
              </button>
            </div>
            <div className="modal-body">
              <p className="form-hint">
                {t('instances.restartStrategy.desc', '选择实例重启方式，不同方式影响退出范围与稳定性。')}
              </p>

              <div
                className={`restart-strategy-option ${pendingStrategy === 'safe' ? 'selected' : ''}`}
                onClick={() => setPendingStrategy('safe')}
              >
                <label className="restart-strategy-header">
                  <input
                    type="radio"
                    name="restartStrategy"
                    checked={pendingStrategy === 'safe'}
                    onChange={() => setPendingStrategy('safe')}
                  />
                  <span className="restart-strategy-title">
                    {t('instances.restartStrategy.safe.title', '安全重启（推荐）')}
                  </span>
                  <span className="restart-strategy-badge">
                    {t('instances.restartStrategy.recommended', '推荐')}
                  </span>
                </label>
                <div className="restart-strategy-body">
                  <div className="restart-strategy-line">
                    <span className="restart-strategy-label">
                      {t('instances.restartStrategy.labels.principle', '技术原理')}
                    </span>
                    <span>
                      {resolveRestartText(
                        'codex.instances.restartStrategy.safe.principle',
                        'instances.restartStrategy.safe.principle',
                        '向所有 Antigravity 进程发送 SIGTERM，请求应用自行保存并退出，退出后再启动目标实例（必要时会强制结束）。',
                      )}
                    </span>
                  </div>
                  <div className="restart-strategy-command">
                    <span className="restart-strategy-label">
                      {t('instances.restartStrategy.labels.command', '命令')}
                    </span>
                    <div className="restart-strategy-command-list">
                      <code>
                        {resolveRestartText(
                          'codex.instances.restartStrategy.safe.commandMac',
                          'instances.restartStrategy.safe.commandMac',
                          'macOS/Linux: kill -15 <pid> （全部 Antigravity 进程）',
                        )}
                      </code>
                      <code>
                        {resolveRestartText(
                          'codex.instances.restartStrategy.safe.commandWin',
                          'instances.restartStrategy.safe.commandWin',
                          'Windows: taskkill /F /PID <pid> （全部 Antigravity 进程）',
                        )}
                      </code>
                    </div>
                  </div>
                  <div className="restart-strategy-line">
                    <span className="restart-strategy-label">
                      {t('instances.restartStrategy.labels.pros', '优点')}
                    </span>
                    <span>{t('instances.restartStrategy.safe.pros', '更接近正常退出，不易触发崩溃提示，数据更安全。')}</span>
                  </div>
                  <div className="restart-strategy-line">
                    <span className="restart-strategy-label">
                      {t('instances.restartStrategy.labels.cons', '缺点')}
                    </span>
                    <span>{t('instances.restartStrategy.safe.cons', '只能整体退出并重启，无法只重启单个实例。')}</span>
                  </div>
                </div>
              </div>

              <div
                className={`restart-strategy-option ${pendingStrategy === 'force' ? 'selected' : ''}`}
                onClick={() => setPendingStrategy('force')}
              >
                <label className="restart-strategy-header">
                  <input
                    type="radio"
                    name="restartStrategy"
                    checked={pendingStrategy === 'force'}
                    onChange={() => setPendingStrategy('force')}
                  />
                  <span className="restart-strategy-title">
                    {t('instances.restartStrategy.force.title', '强制重启')}
                  </span>
                </label>
                <div className="restart-strategy-body">
                  <div className="restart-strategy-line">
                    <span className="restart-strategy-label">
                      {t('instances.restartStrategy.labels.principle', '技术原理')}
                    </span>
                    <span>
                      {resolveRestartText(
                        'codex.instances.restartStrategy.force.principle',
                        'instances.restartStrategy.force.principle',
                        '按 --user-data-dir 匹配进程并强制终止（SIGKILL / taskkill /F），再启动目标实例。',
                      )}
                    </span>
                  </div>
                  <div className="restart-strategy-command">
                    <span className="restart-strategy-label">
                      {t('instances.restartStrategy.labels.command', '命令')}
                    </span>
                    <div className="restart-strategy-command-list">
                      <code>
                        {resolveRestartText(
                          'codex.instances.restartStrategy.force.commandMac',
                          'instances.restartStrategy.force.commandMac',
                          'macOS/Linux: pkill -9 -f "--user-data-dir <dir>"',
                        )}
                      </code>
                      <code>
                        {resolveRestartText(
                          'codex.instances.restartStrategy.force.commandWin',
                          'instances.restartStrategy.force.commandWin',
                          'Windows: taskkill /F /PID <pid> （匹配 --user-data-dir）',
                        )}
                      </code>
                    </div>
                  </div>
                  <div className="restart-strategy-line">
                    <span className="restart-strategy-label">
                      {t('instances.restartStrategy.labels.pros', '优点')}
                    </span>
                    <span>{t('instances.restartStrategy.force.pros', '可精准重启单个实例。')}</span>
                  </div>
                  <div className="restart-strategy-line">
                    <span className="restart-strategy-label">
                      {t('instances.restartStrategy.labels.cons', '缺点')}
                    </span>
                    <span>{t('instances.restartStrategy.force.cons', '可能触发“意外终止”提示，存在未保存数据丢失风险。')}</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowStrategyModal(false)}>
                {t('common.cancel', '取消')}
              </button>
              <button className="btn btn-primary" onClick={handleConfirmStrategy}>
                {t('common.confirm', '确认')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                {editing
                  ? t('instances.modal.editTitle', '编辑实例')
                  : t('instances.modal.createTitle', '新建实例')}
              </h2>
              <button
                className="modal-close"
                onClick={closeModal}
                aria-label={t('common.close', '关闭')}
              >
                <X />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>{t('instances.form.name', '实例名称')}</label>
                <input
                  className="form-input"
                  value={formName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder={t('instances.form.namePlaceholder', '例如：工作账号')}
                  disabled={Boolean(editing?.isDefault)}
                />
              </div>

              <div className="form-group">
                <label>{t('instances.form.path', '实例目录')}</label>
                <div className="instance-path-row">
                  <input
                    className="form-input"
                    value={formPath}
                    onChange={(e) => setFormPath(e.target.value)}
                    placeholder={t('instances.form.pathPlaceholder', '选择实例目录')}
                    disabled={Boolean(editing)}
                  />
                  {!editing && (
                    <button className="btn btn-secondary" onClick={handleSelectPath}>
                      <FolderOpen size={16} />
                      {t('instances.actions.selectPath', '选择目录')}
                    </button>
                  )}
                </div>
                {!editing && (
                  <p className="form-hint">{t('instances.form.pathAutoHint', '修改名称时自动更新路径，也可手动选择')}</p>
                )}
                {editing && (
                  <p className="form-hint">{t('instances.form.pathReadOnly', '编辑时不可修改路径')}</p>
                )}
              </div>

              {!editing && (
                <div className="form-group">
                  <label>{t('instances.form.copySource', '复制来源实例')}</label>
                  <InstanceSelect
                    value={formCopySourceInstanceId}
                    onChange={setFormCopySourceInstanceId}
                  />
                  <p className="form-hint">{t('instances.form.copySourceDesc', '从指定实例复制配置与登录信息')}</p>
                  {selectedCopySourceInstance?.running && (
                    <p className="form-hint warning">
                      {t(
                        'instances.form.copySourceRunningHint',
                        '该实例正在运行，建议先关闭以避免数据不一致',
                      )}
                    </p>
                  )}
                </div>
              )}

              {!editing ? (
                <div className="form-group">
                  <label>{t('instances.form.bindInject', '绑定账号')}</label>
                  <AccountSelect value={formBindAccountId || null} onChange={handleFormAccountChange} />
                </div>
              ) : (
                <div className="form-group">
                  <label>{t('instances.form.bindAccount', '绑定账号')}</label>
                  <AccountSelect
                    value={formBindAccountId || null}
                    onChange={handleFormAccountChange}
                    missing={Boolean(
                      formBindAccountId && !accounts.find((item) => item.id === formBindAccountId),
                    )}
                  />
                </div>
              )}

              <div className="form-group">
                <label>{t('instances.form.extraArgs', '自定义启动参数')}</label>
                <textarea
                  className="form-input instance-args-input"
                  value={formExtraArgs}
                  onChange={(e) => setFormExtraArgs(e.target.value)}
                  placeholder={t('instances.form.extraArgsPlaceholder', '例如：--disable-gpu --log-level=2')}
                />
                <p className="form-hint">{t('instances.form.extraArgsDesc', '按空格分隔参数，支持引号包裹')}</p>
              </div>
              {formError && (
                <div className="form-error" ref={formErrorRef}>
                  {formError}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeModal}>
                {t('common.cancel', '取消')}
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSubmit}
                disabled={actionLoading === 'create' || (editing ? actionLoading === editing.id : false)}
              >
                {editing ? t('common.save', '保存') : t('instances.actions.create', '新建实例')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
