import { useState } from 'react';
import type { WorklogEntry, WorklogFolder } from '../../../electron/worklog-types';
import { MAX_NAME_CHARS } from '../../../electron/worklog-types';
import { BTN_GHOST, BTN_SOLID, INPUT, Modal, SOLID_STYLE } from '../../components/Modal';
import { isoToday, toFileTitle, weekdayOf } from '../format';
import { folderLabel } from './WorklogSidebar';

interface Props {
  folders: WorklogFolder[];
  files: WorklogEntry[];
  defaultFolder?: string;
  onCreate: (folder: string, date: string, title: string) => Promise<boolean>;
  onOpen: (entry: WorklogEntry) => void;
  onClose: () => void;
}

/** 새 일지 — 같은 폴더에 그 날짜 파일이 있으면 만들지 않고 연다(같은 날 파일 2개 방지) */
export function WorklogCreateDialog({ folders, files, defaultFolder, onCreate, onOpen, onClose }: Props) {
  const [folder, setFolder] = useState(defaultFolder ?? folders[0]?.name ?? '');
  const [date, setDate] = useState(isoToday());
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const existing = files.find((f) => f.folder === folder && f.date === date);
  const clean = toFileTitle(title);
  const name = `[${date}] ${clean}.txt`;
  const tooLong = name.length > MAX_NAME_CHARS;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && !!clean && !tooLong;

  const submit = async () => {
    if (existing) {
      onOpen(existing);
      onClose();
      return;
    }
    if (!valid || busy) return;
    setBusy(true);
    const ok = await onCreate(folder, date, clean);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      title="새 작업일지"
      subtitle="파일명은 [날짜] 제목.txt — 1행에도 같은 제목을 씁니다. 제목은 나중에 1행을 고치고 파일명을 맞출 수 있습니다."
      onClose={onClose}
      width={560}
      labelId="wl-create-title"
      footer={
        <>
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted" title={name}>
            {existing ? `이미 있음: ${existing.name}` : clean ? name : ''}
          </span>
          <button type="button" className={BTN_GHOST} onClick={onClose}>
            취소
          </button>
          <button type="button" className={BTN_SOLID} style={SOLID_STYLE} disabled={!existing && (!valid || busy)} onClick={() => void submit()}>
            {existing ? '그 일지 열기' : busy ? '만드는 중…' : '만들기'}
          </button>
        </>
      }
    >
      <form
        className="space-y-3 text-[12.5px]"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {folders.length > 1 && (
          <fieldset>
            <legend className="mb-1 font-semibold text-fg">폴더</legend>
            <div className="flex flex-wrap gap-1.5">
              {folders.map((f) => (
                <label key={f.name} className="flex cursor-pointer items-center gap-1 rounded-sharp border border-rule px-2 py-1">
                  <input type="radio" name="wl-folder" checked={folder === f.name} onChange={() => setFolder(f.name)} />
                  <span>{f.name || folderLabel(f.name)}</span>
                  <span className="text-[10.5px] text-fg-muted">{f.count}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="block">
          <span className="mb-1 block font-semibold text-fg">날짜</span>
          <span className="flex items-center gap-2">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${INPUT} max-w-[180px]`} />
            {/^\d{4}-\d{2}-\d{2}$/.test(date) && <span className="text-fg-muted">({weekdayOf(date)})</span>}
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block font-semibold text-fg">제목</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="예: 한강 SRE BMS 비활성 Job 활성화, 관제 개발팀 패치 문의 대응"
            className={INPUT}
            disabled={!!existing}
          />
          <span className="mt-1 block text-[11px] text-fg-muted">
            {tooLong ? `파일명이 ${MAX_NAME_CHARS}자를 넘습니다 — 줄여 주세요.` : '\\ / : * ? " < > | 는 가운뎃점(·)으로 바뀝니다.'}
          </span>
        </label>
        {existing && (
          <p className="rounded-sharp border border-rule bg-bg-sunken px-2.5 py-2 text-[12px] text-fg-soft">
            이 폴더에 {date} 일지가 이미 있습니다. 같은 날 파일이 둘이면 작업일지 루틴이 그날을 건너뛰므로, 있는 파일을 열어 이어 씁니다.
          </p>
        )}
      </form>
    </Modal>
  );
}
