import { useRef, useState } from 'react';
import { ActionButton } from '../components/ui/action-button.js';
import { SettingsGroupCard, SettingsRow, SettingsSection } from './SettingsPageParts.js';
import { SettingsDialog } from './common.js';
import type { Action } from '../services.js';

type Operation = 'serverDrain' | 'serverGc';
export function SpaceReclamation({ projectId, projectName, action, disabled, onChange }: {
  projectId: string; projectName: string; action: Action; disabled: boolean; onChange: () => Promise<void>;
}) {
  const prefix = `areal-gui:space-maintenance:${projectId}:`;
  const hasUnconfirmed = () => Object.keys(localStorage).some(key => key.startsWith(prefix));
  const [unconfirmed, setUnconfirmed] = useState(hasUnconfirmed);
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const run = async (operation: Operation) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    const key = `${prefix}${crypto.randomUUID()}`;
    try {
      // Retain uncertainty if the Renderer goes away after dispatch. This is UI
      // recovery state, never an execution journal or a reason to replay.
      // Each invocation owns its marker. A later successful operation cannot
      // erase an earlier unknown result, even for the same maintenance action.
      localStorage.setItem(key, operation);
      const result = await action('manage', { projectId, operation });
      if (operation === 'serverDrain') {
        if (result.draining !== true || result.restartSafe !== true) throw new Error('Core 尚未完成收敛，请检查执行与资源状态。');
        setNotice('已停止接收新工作。');
      } else {
        if (!['deletedBlobs', 'reclaimedBytes', 'retainedBytes'].every(field => Number.isSafeInteger(result[field]) && result[field] >= 0)) {
          throw Object.assign(new Error('回收结果不完整，实际释放空间待核对。'), { submissionUnknown: true });
        }
        setNotice(`已回收 ${result.reclaimedBytes} B（${result.deletedBlobs} 个附件），保留 ${result.retainedBytes} B。`);
      }
      localStorage.removeItem(key);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      setError(failure.message);
      if (!failure.submissionUnknown) localStorage.removeItem(key);
      else setNotice('维护操作结果待核对；不会自动重发，也不能确认已释放空间。');
    } finally { setUnconfirmed(hasUnconfirmed()); locked.current = false; setBusy(false); await onChange(); }
  };
  const feedback = <>
    {busy && <p role="status" className="px-4 pb-3 text-ui-sm">正在处理空间维护…</p>}
    {notice && <p role="status" className="px-4 pb-3 text-ui-sm">{notice}</p>}
    {unconfirmed && !busy && <p role="status" className="px-4 pb-3 text-ui-sm">上次维护操作结果待核对；不会自动重发。</p>}
    {error && <p role="alert" className="px-4 pb-3 text-ui-sm text-destructive">{error}</p>}
  </>;
  return <div aria-label="空间回收">
    <SettingsRow label="空间回收" description="回收不再使用的附件，保留聊天历史。"
      control={<ActionButton disabled={disabled || busy} onClick={() => setOpen(true)}>管理空间</ActionButton>} />
    {!open && feedback}
    {open && <SettingsDialog title={`管理空间 · ${projectName}`} description="维护完成后需停止后台并重新连接。"
      busy={busy} onClose={() => setOpen(false)}>
      <SettingsSection title="工作接收">
        <SettingsGroupCard>
          <SettingsRow label="接收新工作" description="停止后进入维护状态。"
            control={<ActionButton disabled={disabled || busy} onClick={() => void run('serverDrain')}>停止接收</ActionButton>} />
        </SettingsGroupCard>
      </SettingsSection>
      <SettingsSection title="附件">
        <SettingsGroupCard>
          <SettingsRow label="未引用附件" description="停止接收后可回收，保留聊天历史。"
            control={<ActionButton disabled={disabled || busy} onClick={() => void run('serverGc')}>回收空间</ActionButton>} />
        </SettingsGroupCard>
      </SettingsSection>
      {feedback}
    </SettingsDialog>}
  </div>;
}
