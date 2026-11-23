import { useEffect, useRef, useState } from 'react';
import { apiError } from './api';

const permissions = { VIEW: 'Chỉ xem', CONTROL: 'Xem và điều khiển' };
const buttonClass = 'rounded bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50';

function RequestDialog({ device, api, onClose, onRequested }) {
  const dialog = useRef(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);

  async function submit(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      await api.post('/permissions/request', {
        device_id: device.id,
        requested_permission: fields.get('permission'),
        request_note: fields.get('note').trim() || null,
      });
      onRequested();
    } catch (error) {
      setError(apiError(error, 'Không thể gửi yêu cầu truy cập.'));
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} onCancel={onClose} aria-labelledby="request-title"
      className="m-auto w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-6 text-slate-100 backdrop:bg-slate-950/80">
      <h2 id="request-title" className="mb-4 text-lg font-semibold">Xin quyền truy cập {device.device_name}</h2>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm">
          Mức quyền
          <select name="permission" className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 p-2">
            {Object.entries(permissions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          Ghi chú cho admin
          <textarea name="note" maxLength={255} rows={3} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 p-2" />
        </label>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-3">
          <button type="button" disabled={busy} onClick={onClose} className="rounded border border-slate-700 px-3 py-2 text-sm">Hủy</button>
          <button disabled={busy} className={buttonClass}>{busy ? 'Đang gửi…' : 'Gửi yêu cầu'}</button>
        </div>
      </form>
    </dialog>
  );
}

export default function DeviceCatalog({ devices, loaded, api, onOpen, onRequested }) {
  const [requestDevice, setRequestDevice] = useState(null);
  return (
    <section className="space-y-4" aria-labelledby="catalog-title">
      <h2 id="catalog-title" className="text-xl font-semibold">Danh mục thiết bị</h2>
      {loaded && devices.length === 0 && <p className="text-sm text-slate-400">Danh mục hiện chưa có node.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {devices.map(device => (
          <article key={device.id} className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-5">
            <h3 className="font-semibold">{device.device_name}</h3>
            <p className="text-sm text-slate-400">{device.device_code} · {device.location}</p>
            <p className="text-xs text-slate-400">Vòng đời {device.lifecycle_status}</p>
            {device.access_status === 'APPROVED' ? (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                <span className="text-sm font-medium text-teal-300">{permissions[device.permission]}</span>
                <button onClick={() => onOpen(device.device_code)} className={buttonClass}>Mở giám sát</button>
              </div>
            ) : device.access_status === 'PENDING' ? (
              <p className="pt-2 text-sm text-amber-300">Đang chờ admin phê duyệt</p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                <span className="text-sm text-slate-400">{device.access_status === 'REJECTED' ? 'Yêu cầu đã bị từ chối' : 'Chưa có quyền xem số liệu'}</span>
                <button onClick={() => setRequestDevice(device)} className={buttonClass}>Xin quyền truy cập</button>
              </div>
            )}
          </article>
        ))}
      </div>
      {requestDevice && (
        <RequestDialog device={requestDevice} api={api} onClose={() => setRequestDevice(null)}
          onRequested={() => { setRequestDevice(null); onRequested(); }} />
      )}
    </section>
  );
}
