import { useEffect, useState } from 'react';
import { apiError } from './api';

const panel = 'space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5';
const input = 'mt-1 block w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm';
const button = 'rounded bg-teal-600 px-3 py-2 text-sm text-white hover:bg-teal-700 disabled:opacity-50';
const secondary = 'rounded border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50';

function PermissionSelect({ name, value, onChange, label, disabled }) {
  return (
    <select name={name} value={value} onChange={onChange} aria-label={label} disabled={disabled} className={input}>
      <option value="VIEW">Chỉ xem (VIEW)</option>
      <option value="CONTROL">Điều khiển (CONTROL)</option>
    </select>
  );
}

function TextField({ label, ...props }) {
  return <label className="block text-sm">{label}<input required className={input} {...props} /></label>;
}

function PermissionTable({ title, entries, emptyMessage, pending, busy, onReview, onChange, onRevoke }) {
  return (
    <section className={panel}>
      <h2 className="font-semibold">{title}</h2>
      {entries.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="p-2">Tài khoản</th><th className="p-2">Node</th><th className="p-2">Mức quyền</th>
                {pending && <><th className="p-2">Ghi chú</th><th className="p-2">Thời gian gửi</th></>}
                <th className="p-2">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {entries.map(entry => (
                <tr key={entry.id}>
                  <td className="p-2">{entry.full_name}<span className="block text-slate-400">{entry.username}</span></td>
                  <td className="p-2">{entry.device_name}<span className="block text-slate-400">{entry.device_code}</span></td>
                  <td className="p-2">
                    {pending ? entry.permission : (
                      <PermissionSelect value={entry.permission} label={`Quyền của ${entry.username} trên ${entry.device_code}`}
                        disabled={busy} onChange={event => onChange(entry.id, event.target.value)} />
                    )}
                  </td>
                  {pending && <>
                    <td className="max-w-xs break-words p-2">{entry.request_note || '—'}</td>
                    <td className="p-2">{entry.requested_at?.replace('T', ' ')}</td>
                  </>}
                  <td className="p-2">
                    {pending ? (
                      <div className="flex flex-wrap gap-2">
                        <button className={secondary} disabled={busy || entry.lifecycle_status === 'DECOMMISSIONED'}
                          onClick={() => onReview(entry, 'APPROVE', 'VIEW')}>Duyệt (Xem)</button>
                        <button className={secondary} disabled={busy || entry.lifecycle_status === 'DECOMMISSIONED'}
                          onClick={() => onReview(entry, 'APPROVE', 'CONTROL')}>Duyệt (Điều khiển)</button>
                        <button className={secondary} disabled={busy}
                          onClick={() => onReview(entry, 'REJECT', entry.permission)}>Từ chối</button>
                      </div>
                    ) : (
                      <button className={secondary} disabled={busy} onClick={() => onRevoke(entry)}>Thu hồi quyền</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-sm text-slate-400">{emptyMessage}</p>}
    </section>
  );
}

export default function AdminAccess({ api, catalog, devices, refreshDevices, openDevice }) {
  const [data, setData] = useState({ users: [], pending: [], approved: [] });
  const [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState('VIEWER');
  const [grants, setGrants] = useState({});
  const [provisioned, setProvisioned] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    Promise.all([
      api.get('/admin/users', options),
      api.get('/admin/permissions/pending', options),
      api.get('/admin/permissions', options),
    ]).then(([users, pending, approved]) => {
      if (controller.signal.aborted) return;
      setData({ users: users.data, pending: pending.data, approved: approved.data });
      setLoadError('');
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(apiError(error, 'Không thể tải dữ liệu phân quyền.'));
    });
    return () => controller.abort();
  }, [api, revision]);

  async function run(operation, success) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
      setMessage(success);
      setRevision(value => value + 1);
    } catch (error) {
      setError(apiError(error, 'Thao tác thất bại. Vui lòng kiểm tra thông tin và thử lại.'));
    } finally {
      setBusy(false);
    }
  }

  function submitAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    const device_grants = role === 'ADMIN' ? [] : catalog
      .filter(device => grants[device.id])
      .map(device => ({ device_id: device.id, permission: grants[device.id] }));
    run(async () => {
      await api.post('/admin/users', { ...fields, role, device_grants });
      form.reset();
      setRole('VIEWER');
      setGrants({});
    }, 'Đã tạo tài khoản.');
  }

  function submitGrant(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    run(() => api.post('/admin/permissions', {
      user_id: Number(fields.get('user_id')),
      device_id: Number(fields.get('device_id')),
      permission: fields.get('permission'),
    }), 'Đã cấp quyền theo node.');
  }

  function submitDevice(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    run(async () => {
      const response = await api.post('/devices/onboard', fields);
      setProvisioned(response.data);
      form.reset();
      refreshDevices();
    }, 'Đã thêm node.');
  }

  function revoke(entry) {
    if (window.confirm(`Thu hồi quyền của ${entry.username} trên ${entry.device_code}?`)) {
      run(() => api.delete(`/admin/permissions/${entry.id}`), 'Đã thu hồi quyền.');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Quản lý phân quyền</h2>
        <button className={secondary} disabled={busy} onClick={() => setRevision(value => value + 1)}>Làm mới</button>
      </div>
      {loadError && <p role="alert" className="text-sm text-red-300">{loadError}</p>}
      {error && <p role="alert" className="sticky top-0 z-10 rounded bg-red-950 p-3 text-sm text-red-200">{error}</p>}
      {message && <p role="status" className="text-sm text-teal-300">{message}</p>}

      <PermissionTable title="Yêu cầu chờ duyệt" entries={data.pending} emptyMessage="Chưa có yêu cầu chờ duyệt." pending busy={busy}
        onReview={(entry, action, permission) => run(
          () => api.put(`/admin/permissions/${entry.id}/review`, { action, permission }), 'Đã xử lý yêu cầu.',
        )} />
      <PermissionTable title="Quyền đã cấp" entries={data.approved} emptyMessage="Chưa có quyền được cấp." busy={busy}
        onChange={(id, permission) => run(() => api.put(`/admin/permissions/${id}`, { permission }), 'Đã cập nhật quyền.')}
        onRevoke={revoke} />

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <section className={panel}>
          <h2 className="font-semibold">Tạo tài khoản</h2>
          <form onSubmit={submitAccount} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Tên đăng nhập" name="username" autoComplete="off" maxLength={50} />
              <TextField label="Email" name="email" type="email" maxLength={100} />
              <TextField label="Họ tên" name="full_name" maxLength={100} />
              <TextField label="Mật khẩu" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={72} />
            </div>
            <label className="block text-sm">
              Vai trò tài khoản
              <select value={role} onChange={event => setRole(event.target.value)} className={input}>
                <option value="VIEWER">VIEWER</option>
                <option value="OPERATOR">OPERATOR</option>
                <option value="ADMIN">ADMIN</option>
              </select>
            </label>
            {role !== 'ADMIN' && catalog.length > 0 && (
              <fieldset className="max-h-64 space-y-2 overflow-y-auto rounded border border-slate-800 p-3">
                <legend className="px-2 text-sm">Quyền theo node</legend>
                {catalog.map(device => (
                  <div key={device.id} className="grid items-center gap-2 sm:grid-cols-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={Boolean(grants[device.id])}
                        onChange={event => {
                          const permission = event.target.checked ? 'VIEW' : '';
                          setGrants(current => ({ ...current, [device.id]: permission }));
                        }} />
                      {device.device_name}
                    </label>
                    {grants[device.id] && <PermissionSelect value={grants[device.id]} label={`Quyền trên ${device.device_code}`}
                      onChange={event => {
                        const permission = event.target.value;
                        setGrants(current => ({ ...current, [device.id]: permission }));
                      }} />}
                  </div>
                ))}
              </fieldset>
            )}
            <button className={button} disabled={busy}>Tạo tài khoản</button>
          </form>
        </section>

        <section className={panel}>
          <h2 className="font-semibold">Cấp quyền cho tài khoản hiện có</h2>
          <form onSubmit={submitGrant} className="space-y-3">
            <label className="block text-sm">Tài khoản
              <select name="user_id" defaultValue="" required className={input}>
                <option value="" disabled>Chọn tài khoản</option>
                {data.users.map(user => <option key={user.id} value={user.id}>{user.full_name} ({user.username})</option>)}
              </select>
            </label>
            <label className="block text-sm">Node
              <select name="device_id" defaultValue="" required className={input}>
                <option value="" disabled>Chọn node</option>
                {catalog.map(device => <option key={device.id} value={device.id}>{device.device_name} ({device.device_code})</option>)}
              </select>
            </label>
            <label className="block text-sm">Mức quyền<PermissionSelect name="permission" /></label>
            <button className={button} disabled={busy || !data.users.length || !catalog.length}>Cấp quyền</button>
          </form>
        </section>

        <section className={panel}>
          <h2 className="font-semibold">Thêm node</h2>
          <form onSubmit={submitDevice} className="space-y-3">
            <TextField label="Mã node" name="device_code" maxLength={50} pattern="[A-Za-z0-9_\-]+" />
            <TextField label="Tên node" name="device_name" maxLength={100} />
            <TextField label="Vị trí" name="location" maxLength={100} />
            <button className={button} disabled={busy}>Thêm node</button>
          </form>
          {provisioned && (
            <div className="space-y-2 rounded border border-teal-700 p-3">
              <label className="block text-sm">Token cấu hình ESP32 cho {provisioned.device_code}
                <input readOnly value={provisioned.secret_token} onFocus={event => event.target.select()} className={input} />
              </label>
              <button className={secondary} onClick={() => setProvisioned(null)}>Ẩn token</button>
            </div>
          )}
        </section>

        {devices.some(device => device.lifecycle_status === 'DECOMMISSIONED') && (
          <section className={panel}>
            <h2 className="font-semibold">Node đã ngừng hoạt động</h2>
            {devices.filter(device => device.lifecycle_status === 'DECOMMISSIONED').map(device => (
              <div key={device.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>{device.device_name} ({device.device_code})</span>
                <button className={secondary} onClick={() => openDevice(device.device_code, 'control')}>Quản lý vòng đời</button>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
