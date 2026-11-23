import { useState } from 'react';
import { Activity } from 'lucide-react';
import { apiError, createApi } from './api';

const api = createApi();
const inputClass = 'mt-1 w-full rounded border border-slate-700 bg-slate-900 p-3 text-white focus:border-teal-500 focus:outline-none';

function Field({ label, ...props }) {
  return <label className="block text-sm font-medium text-slate-300">{label}<input required className={inputClass} {...props} /></label>;
}

export default function AuthScreen({ onLogin }) {
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function submit(event) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (registering) {
        await api.post('/auth/register', fields);
        setRegistering(false);
        setMessage('Đã tạo tài khoản. Đăng nhập để chọn node và gửi yêu cầu truy cập.');
      } else {
        const response = await api.post('/auth/login', fields);
        onLogin(response.data.access_token);
      }
    } catch (error) {
      setError(apiError(error, registering ? 'Không thể đăng ký. Hãy kiểm tra thông tin đã nhập.' : 'Đăng nhập thất bại.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-800 p-8 shadow-2xl">
        <div className="mb-8 text-center">
          <Activity className="mx-auto mb-2 h-12 w-12 text-teal-400" />
          <h1 className="text-2xl font-bold text-white">Hệ Thống Giám Sát Không Khí</h1>
          <p className="mt-1 text-sm text-slate-400">Đồ Án IoT & Ứng Dụng - Nhóm 13</p>
        </div>
        {error && <p role="alert" className="mb-4 rounded border border-red-500 bg-red-900/50 p-3 text-sm text-red-200">{error}</p>}
        {message && <p role="status" className="mb-4 text-sm text-teal-300">{message}</p>}
        <form key={registering ? 'register' : 'login'} onSubmit={submit} className="space-y-4">
          <Field label="Tên đăng nhập" name="username" autoComplete="username" maxLength={50} />
          {registering && <>
            <Field label="Họ tên" name="full_name" autoComplete="name" maxLength={100} />
            <Field label="Email" name="email" type="email" autoComplete="email" maxLength={100} />
          </>}
          <Field label="Mật khẩu" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'}
            minLength={registering ? 8 : undefined} maxLength={registering ? 72 : undefined} />
          <button disabled={busy} className="w-full rounded bg-teal-600 py-3 font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
            {registering ? 'Đăng ký' : 'Đăng nhập'}
          </button>
        </form>
        <button disabled={busy} onClick={() => { setRegistering(!registering); setError(''); setMessage(''); }}
          className="mt-4 w-full text-sm font-medium text-teal-300 hover:underline disabled:opacity-50">
          {registering ? 'Quay lại đăng nhập' : 'Tạo tài khoản mới'}
        </button>
      </div>
    </div>
  );
}
