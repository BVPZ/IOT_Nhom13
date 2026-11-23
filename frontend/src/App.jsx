import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Shield, Power, Settings, AlertTriangle,
  LogOut, Wind, Thermometer, Droplets, Cloud, Lock, Server, Wifi
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import AdminAccess from './AdminAccess';
import AuthScreen from './AuthScreen';
import DeviceCatalog from './DeviceCatalog';
import { apiError, createApi } from './api';

const POLL_INTERVAL = 5000;
const VIEW_ONLY = 'Tài khoản chỉ có quyền Giám sát (VIEW)';
const DETAIL_TABS = ['monitoring', 'control', 'alerts'];

function poll(load) {
  const controller = new AbortController();
  let timeout;
  async function refresh() {
    await load(controller.signal);
    if (!controller.signal.aborted) timeout = window.setTimeout(refresh, POLL_INTERVAL);
  }
  refresh();
  return () => {
    controller.abort();
    window.clearTimeout(timeout);
  };
}

function NavigationTab({ active, onClick, children }) {
  const color = active ? 'border-teal-400 text-teal-400' : 'border-transparent text-slate-400 hover:text-slate-200';
  return <button aria-current={active ? 'page' : undefined} onClick={onClick}
    className={`flex shrink-0 items-center gap-2 border-b-2 py-3 ${color}`}>{children}</button>;
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token') || '');

  function login(accessToken) {
    localStorage.setItem('token', accessToken);
    setToken(accessToken);
  }

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken('');
  }, []);

  return token
    ? <Dashboard key={token} token={token} onLogout={logout} />
    : <AuthScreen onLogin={login} />;
}

function Dashboard({ token, onLogout }) {
  const api = useMemo(() => createApi(token), [token]);
  const [account, setAccount] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [devices, setDevices] = useState([]);
  const [apiStatus, setApiStatus] = useState('loading');
  const [activeTab, setActiveTab] = useState('catalog');
  const [selectedDevice, setSelectedDevice] = useState('');
  const [details, setDetails] = useState(null);
  const [liveSamples, setLiveSamples] = useState([]);
  const [liveStatus, setLiveStatus] = useState('connecting');
  const [auditLogs, setAuditLogs] = useState([]);
  const [actionMsg, setActionMsg] = useState('');
  const [revision, setRevision] = useState(0);
  const [configEdits, setConfigEdits] = useState({});
  const refreshDevices = useCallback(() => setRevision(value => value + 1), []);
  const isAdmin = account?.role === 'ADMIN';
  const visibleCatalog = isAdmin
    ? devices.map(device => ({ ...device, access_status: 'APPROVED', permission: 'CONTROL' }))
    : catalog;
  const currentDev = devices.find(device => device.device_code === selectedDevice);
  const tab = (DETAIL_TABS.includes(activeTab) && !currentDev)
    || (['admin', 'audit'].includes(activeTab) && !isAdmin) ? 'catalog' : activeTab;
  const canControl = currentDev?.permission === 'CONTROL';
  const isDeviceDataHidden = ['MAINTENANCE', 'DECOMMISSIONED'].includes(currentDev?.lifecycle_status);
  const selectedDetails = currentDev && details?.deviceCode === selectedDevice ? details : null;
  const telemetry = selectedDetails?.telemetry || [];
  const alerts = selectedDetails?.alerts || [];
  const currentLiveSamples = liveSamples.filter(sample => sample.deviceCode === selectedDevice);
  const livePoint = currentLiveSamples.at(-1)?.point;
  const chartTelemetry = [...telemetry, ...currentLiveSamples.map(sample => sample.point)].slice(-60);
  const latest = livePoint || telemetry.at(-1) || { Temp: '—', Hum: '—', eCO2: '—', TVOC: '—' };
  const config = {
    send_interval_ms: currentDev?.send_interval_ms ?? 5000,
    eco2_threshold: currentDev?.eco2_threshold ?? 1500,
    temp_threshold: currentDev?.temp_threshold ?? 35,
    tvoc_threshold: currentDev?.tvoc_threshold ?? 600,
    ...configEdits,
  };
  const { send_interval_ms: sendInterval, eco2_threshold: eco2Threshold,
    temp_threshold: tempThreshold, tvoc_threshold: tvocThreshold } = config;

  useEffect(() => poll(async signal => {
    try {
      const [userResponse, devicesResponse] = await Promise.all([
        api.get('/auth/me', { signal }),
        api.get('/devices', { signal }),
      ]);
      const user = userResponse.data;
      const userCatalog = user.role === 'ADMIN' ? [] : (await api.get('/devices/catalog', { signal })).data;
      if (signal.aborted) return;
      setAccount(user);
      setCatalog(userCatalog);
      setDevices(devicesResponse.data);
      setSelectedDevice(code => devicesResponse.data.some(device => device.device_code === code) ? code : '');
      setApiStatus('ready');
    } catch (error) {
      if (signal.aborted) return;
      if (error.response?.status === 401) onLogout();
      else setApiStatus('error');
    }
  }), [api, onLogout, revision]);

  const detailCode = currentDev && DETAIL_TABS.includes(tab) ? currentDev.device_code : '';
  useEffect(() => {
    if (!detailCode) return;
    setLiveStatus('connecting');
    const path = `/devices/${encodeURIComponent(detailCode)}`;
    return poll(async signal => {
      try {
        const [samples, deviceAlerts] = await Promise.all([
          api.get(`${path}/telemetry`, { signal, params: { limit: 25 } }),
          api.get(`${path}/alerts`, { signal }),
        ]);
        if (signal.aborted) return;
        setDetails({
          deviceCode: detailCode,
          telemetry: samples.data.map(sample => ({
            time: sample.recorded_at?.split(/[T ]/)[1]?.slice(0, 8) || '',
            Temp: sample.temperature, Hum: sample.humidity, eCO2: sample.eco2, TVOC: sample.tvoc,
          })),
          alerts: deviceAlerts.data,
        });
      } catch (error) {
        if (signal.aborted) return;
        if (error.response?.status === 401) onLogout();
        else if ([403, 404].includes(error.response?.status)) {
          setDetails(null);
          setSelectedDevice(code => code === detailCode ? '' : code);
          setActionMsg('Node này không còn khả dụng hoặc quyền truy cập đã thay đổi.');
        } else {
          setDetails({ deviceCode: detailCode, error: apiError(error, 'Không thể tải số liệu và cảnh báo của node.') });
        }
      }
    });
  }, [api, detailCode, onLogout, revision]);

  useEffect(() => {
    if (!detailCode) return;
    const controller = new AbortController();
    let reader;
    const connect = async () => {
      while (!controller.signal.aborted) {
        try {
          setLiveStatus('connecting');
          const response = await fetch(`${api.defaults.baseURL}/devices/${encodeURIComponent(detailCode)}/live`, {
            headers: { Authorization: api.defaults.headers.common.Authorization },
            signal: controller.signal,
          });
          if (response.status === 404) {
            setLiveStatus('unsupported');
            break;
          }
          if (response.status === 401) {
            onLogout();
            break;
          }
          if (!response.ok || !response.body) throw new Error(`Live stream failed (${response.status})`);
          setLiveStatus('connected');
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const event of events) {
              const dataLine = event.split(/\r?\n/).find(line => line.startsWith('data: '));
              if (!dataLine) continue;
              const update = JSON.parse(dataLine.slice(6));
              const sample = update.sample;
              const point = {
                sequence: update.sequence,
                time: sample.recorded_at?.split(/[T ]/)[1]?.slice(0, 8) || '',
                Temp: sample.temperature, Hum: sample.humidity,
                eCO2: sample.eco2, TVOC: sample.tvoc,
              };
              setLiveSamples(previous => {
                const deviceSamples = previous.filter(item => item.deviceCode === detailCode);
                if (deviceSamples.some(item => item.point.sequence === point.sequence)) return previous;
                return [...previous.filter(item => item.deviceCode !== detailCode),
                  ...deviceSamples, { deviceCode: detailCode, point }].slice(-120);
              });
            }
          }
          if (!controller.signal.aborted) setLiveStatus('disconnected');
        } catch (error) {
          if (controller.signal.aborted) break;
          setLiveStatus('disconnected');
        }
        await new Promise(resolve => { reconnectTimeout = window.setTimeout(resolve, 1500); });
      }
    };
    let reconnectTimeout;
    connect();
    return () => {
      controller.abort();
      window.clearTimeout(reconnectTimeout);
      reader?.cancel().catch(() => {});
    };
  }, [api, detailCode, onLogout]);

  useEffect(() => {
    if (tab !== 'audit') return;
    return poll(async signal => {
      try {
        const response = await api.get('/audit-logs', { signal });
        if (!signal.aborted) setAuditLogs(response.data);
      } catch (error) {
        if (signal.aborted) return;
        if (error.response?.status === 401) onLogout();
        else setActionMsg(apiError(error, 'Không thể tải nhật ký bảo mật.'));
      }
    });
  }, [api, onLogout, tab]);

  function openDevice(code, nextTab = 'monitoring') {
    if (code !== selectedDevice) {
      setDetails(null);
      setLiveSamples([]);
      setConfigEdits({});
      setActionMsg('');
    }
    setSelectedDevice(code);
    setActiveTab(nextTab);
  }

  function updateConfigField(field, value) {
    setConfigEdits(edits => ({ ...edits, [field]: value }));
  }

  async function perform(operation, fallback) {
    try {
      await operation();
    } catch (error) {
      if (error.response?.status === 401) onLogout();
      else {
        setActionMsg(apiError(error, fallback));
        if (error.response?.status === 403) refreshDevices();
      }
    }
  }

  const devicePath = `/devices/${encodeURIComponent(selectedDevice)}`;

  function handleCommand(action) {
    if (!canControl || isDeviceDataHidden) return;
    return perform(async () => {
      const response = await api.post(`${devicePath}/command`, { target: 'FAN_RELAY', action });
      setActionMsg(response.data.message);
    }, 'Không thể gửi lệnh điều khiển.');
  }

  function handleUpdateConfig(event) {
    event.preventDefault();
    if (!canControl || isDeviceDataHidden) return;
    const submittedEdits = configEdits;
    return perform(async () => {
      const response = await api.put(`${devicePath}/config`, {
        send_interval_ms: Number(sendInterval), eco2_threshold: Number(eco2Threshold),
        temp_threshold: Number(tempThreshold), tvoc_threshold: Number(tvocThreshold),
      });
      setDevices(items => items.map(item => item.device_code === selectedDevice ? { ...item, ...response.data.config } : item));
      setConfigEdits(edits => edits === submittedEdits ? {} : edits);
      setActionMsg(response.data.message);
      refreshDevices();
    }, 'Không thể cập nhật cấu hình. Hãy kiểm tra các giá trị đã nhập.');
  }

  function handleLifecycle(status) {
    if (!window.confirm(`Xác nhận đổi trạng thái thiết bị sang ${status}?`)) return;
    return perform(async () => {
      await api.put(`${devicePath}/lifecycle`, { lifecycle_status: status });
      setDevices(items => items.map(item => item.device_code === selectedDevice
        ? { ...item, lifecycle_status: status, is_online: status === 'ACTIVE' ? item.is_online : 0 }
        : item));
      setDetails(null);
      setActionMsg(`Đã chuyển thiết bị sang trạng thái ${status}.`);
      refreshDevices();
    }, 'Không thể đổi trạng thái thiết bị.');
  }

  function handleAckAlert(id) {
    if (!canControl) return;
    return perform(async () => {
      await api.put(`/alerts/${id}/acknowledge`, { resolve_note: 'Đã kiểm tra và xử lý thông gió phòng' });
      refreshDevices();
    }, 'Không thể xác nhận cảnh báo.');
  }
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Header */}
      <header className="bg-slate-900 border-b border-slate-800 px-6 py-4 flex flex-wrap justify-between items-center gap-4">
        <div className="flex items-center gap-3">
          <Activity className="w-7 h-7 text-teal-400" />
          <div>
            <h1 className="font-bold text-lg text-white">Trạm Giám Sát Chất Lượng Không Khí IoT</h1>
            <p className="text-xs text-slate-400">Học viện Công nghệ Bưu chính Viễn thông</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs bg-slate-800 border border-slate-700 px-3 py-1 rounded">
            <Wifi className={`w-3.5 h-3.5 ${apiStatus === 'ready' ? 'text-emerald-400' : 'text-amber-400'}`} />
            <strong role="status" className={apiStatus === 'ready' ? 'text-emerald-400' : 'text-amber-400'}>
              {{ ready: 'Đã kết nối API', loading: 'Đang kết nối API', error: 'Không thể kết nối API' }[apiStatus]}
            </strong>
          </div>

          <div className="text-right">
            <span className="text-sm font-medium text-white">{account?.full_name}</span>
            <div className="flex items-center justify-end gap-1">
              <span className={`text-xs px-2 py-0.5 rounded font-bold ${
                isAdmin ? 'bg-purple-900 text-purple-300' : 'bg-slate-800 text-slate-300'
              }`}>
                {account?.role}
              </span>
            </div>
          </div>
          <button 
            onClick={onLogout}
            className="p-2 hover:bg-slate-800 rounded text-slate-400 hover:text-white"
            title="Đăng xuất"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Action Notification Toast */}
      {actionMsg && (
        <div className="bg-teal-900/60 border-b border-teal-500/50 px-6 py-2 text-sm text-teal-200 flex justify-between items-center">
          <span>{actionMsg}</span>
          <button onClick={() => setActionMsg('')} className="text-xs text-teal-400 hover:underline">Đóng</button>
        </div>
      )}

      {/* Main Navigation Tabs */}
      <nav className="flex flex-wrap gap-x-6 border-b border-slate-800 bg-slate-900/50 px-6 text-sm font-medium">
        <NavigationTab active={tab === 'catalog'} onClick={() => setActiveTab('catalog')}>
          <Server className="w-4 h-4" /> Danh mục node
        </NavigationTab>
        {currentDev && (
          <>
            <NavigationTab active={tab === 'monitoring'} onClick={() => setActiveTab('monitoring')}>
              <Activity className="w-4 h-4" /> Giám sát
            </NavigationTab>
            <NavigationTab active={tab === 'control'} onClick={() => setActiveTab('control')}>
              <Power className="w-4 h-4" /> Điều khiển và cấu hình
            </NavigationTab>
            <NavigationTab active={tab === 'alerts'} onClick={() => setActiveTab('alerts')}>
              <AlertTriangle className="w-4 h-4" /> Cảnh báo ({alerts.filter(alert => alert.status === 'NEW').length})
            </NavigationTab>
          </>
        )}
        {isAdmin && (
          <>
            <NavigationTab active={tab === 'admin'} onClick={() => setActiveTab('admin')}>
              <Lock className="w-4 h-4" /> Quản lý phân quyền
            </NavigationTab>
            <NavigationTab active={tab === 'audit'} onClick={() => setActiveTab('audit')}>
              <Shield className="w-4 h-4" /> Nhật ký bảo mật
            </NavigationTab>
          </>
        )}
      </nav>

      {/* Tab Content Area */}
      <main className="p-6 flex-1 overflow-auto space-y-6">
        {tab === 'catalog' && <DeviceCatalog devices={visibleCatalog} loaded={Boolean(account)} api={api} onOpen={openDevice}
          onRequested={() => { setActionMsg('Đã gửi yêu cầu truy cập.'); refreshDevices(); }} />}
        {tab === 'admin' && <AdminAccess api={api} catalog={visibleCatalog} devices={devices} refreshDevices={refreshDevices} openDevice={openDevice} />}
        {detailCode && selectedDetails?.error && <p role="alert" className="text-sm text-amber-300">{selectedDetails.error}</p>}

        {/* Device Status Bar */}
        {detailCode && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-wrap justify-between items-center gap-4">
          <div className="flex items-center gap-3">
            <Server className="w-5 h-5 text-teal-400" />
            <div>
              <span className="font-semibold text-white">{currentDev.device_name || selectedDevice}</span>
              <span className="text-xs text-slate-400 ml-2">({currentDev.location})</span>
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-1.5">
              <span className={`w-3 h-3 rounded-full ${currentDev.is_online ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
              <strong className={currentDev.is_online ? 'text-emerald-400' : 'text-red-400'}>
                {currentDev.is_online ? 'ONLINE' : 'OFFLINE'}
              </strong>
            </span>
            <span className="text-xs bg-slate-800 border border-slate-700 px-2 py-1 rounded">
              Vòng đời: <strong className="text-teal-300">{currentDev.lifecycle_status}</strong>
            </span>
            <span className="text-sm text-teal-300">{canControl ? 'Xem và điều khiển' : 'Chỉ xem'}</span>
          </div>
        </div>
        )}

        {/* TAB 1: GIÁM SÁT THỜI GIAN THỰC (MONITORING) */}
        {tab === 'monitoring' && (
          isDeviceDataHidden ? (
            <div className="rounded-lg border border-amber-700 bg-amber-950/30 p-6 text-center">
              <h2 className="text-lg font-semibold text-amber-300">Dữ liệu thiết bị đang được ẩn</h2>
              <p className="mt-2 text-sm text-slate-300">
                Thiết bị đang ở trạng thái {currentDev.lifecycle_status}. Chuyển thiết bị về ACTIVE để xem dữ liệu.
              </p>
            </div>
          ) : (
          <div className="space-y-6">
            {/* 4 Cards Số đo */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-slate-900 border border-slate-800 p-5 rounded-lg flex items-center justify-between">
                <div>
                  <p className="text-slate-400 text-xs uppercase font-medium">Nhiệt độ (DHT22)</p>
                  <p className="text-3xl font-bold text-white mt-1">{latest.Temp} <span className="text-sm font-normal text-slate-400">°C</span></p>
                </div>
                <Thermometer className="w-10 h-10 text-orange-400 bg-orange-950/40 p-2 rounded-lg" />
              </div>

              <div className="bg-slate-900 border border-slate-800 p-5 rounded-lg flex items-center justify-between">
                <div>
                  <p className="text-slate-400 text-xs uppercase font-medium">Độ ẩm (DHT22)</p>
                  <p className="text-3xl font-bold text-white mt-1">{latest.Hum} <span className="text-sm font-normal text-slate-400">%</span></p>
                </div>
                <Droplets className="w-10 h-10 text-blue-400 bg-blue-950/40 p-2 rounded-lg" />
              </div>

              <div className={`border p-5 rounded-lg flex items-center justify-between ${
                latest.eCO2 > eco2Threshold ? 'bg-red-950/20 border-red-800' : 'bg-slate-900 border-slate-800'
              }`}>
                <div>
                  <p className="text-slate-400 text-xs uppercase font-medium">Khí eCO2 (CCS811)</p>
                  <p className={`text-3xl font-bold mt-1 ${latest.eCO2 > eco2Threshold ? 'text-red-400' : 'text-emerald-400'}`}>
                    {latest.eCO2} <span className="text-sm font-normal text-slate-400">ppm</span>
                  </p>
                </div>
                <Cloud className={`w-10 h-10 p-2 rounded-lg ${latest.eCO2 > eco2Threshold ? 'text-red-400 bg-red-950/50' : 'text-emerald-400 bg-emerald-950/40'}`} />
              </div>

              <div className={`border p-5 rounded-lg flex items-center justify-between ${
                latest.TVOC > tvocThreshold ? 'bg-amber-950/20 border-amber-800' : 'bg-slate-900 border-slate-800'
              }`}>
                <div>
                  <p className="text-slate-400 text-xs uppercase font-medium">Khí TVOC (CCS811)</p>
                  <p className={`text-3xl font-bold mt-1 ${latest.TVOC > tvocThreshold ? 'text-amber-400' : 'text-teal-400'}`}>
                    {latest.TVOC} <span className="text-sm font-normal text-slate-400">ppb</span>
                  </p>
                </div>
                <Wind className={`w-10 h-10 p-2 rounded-lg ${latest.TVOC > tvocThreshold ? 'text-amber-400 bg-amber-950/40' : 'text-teal-400 bg-teal-950/40'}`} />
              </div>
            </div>

            {/* Biểu đồ Thời gian thực (Recharts) */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-lg">
              <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
                <Activity className="w-5 h-5 text-teal-400" /> Biểu đồ diễn biến chất lượng không khí
                <span className={`ml-auto inline-flex items-center gap-1.5 text-xs ${liveStatus === 'connected' ? 'text-emerald-400' : 'text-amber-300'}`}>
                  <span className={`h-2 w-2 rounded-full ${liveStatus === 'connected' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-300'}`} />
                  {liveStatus === 'connected' ? 'Đang nhận trực tiếp'
                    : liveStatus === 'unsupported' ? 'Backend chưa hỗ trợ luồng trực tiếp'
                      : liveStatus === 'disconnected' ? 'Mất kết nối, đang thử lại' : 'Đang kết nối...'}
                </span>
              </h2>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartTelemetry}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="time" stroke="#94a3b8" />
                    <YAxis yAxisId="left" stroke="#38bdf8" />
                    <YAxis yAxisId="right" orientation="right" stroke="#34d399" />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155' }} />
                    <Legend />
                    <Line yAxisId="left" type="monotone" dataKey="Temp" name="Nhiệt độ (°C)" stroke="#fb923c" strokeWidth={2} dot={false} />
                    <Line yAxisId="left" type="monotone" dataKey="Hum" name="Độ ẩm (%)" stroke="#38bdf8" strokeWidth={2} dot={false} />
                    <Line yAxisId="right" type="monotone" dataKey="eCO2" name="eCO2 (ppm)" stroke="#34d399" strokeWidth={2} dot={false} />
                    <Line yAxisId="left" type="monotone" dataKey="TVOC" name="TVOC (ppb)" stroke="#2dd4bf" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          )
        )}

        {/* TAB 2: ĐIỀU KHIỂN & CẤU HÌNH THIẾT BỊ (CONTROL & CONFIG) */}
        {tab === 'control' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Khối Điều khiển Quạt */}
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-lg space-y-4">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Power className="w-5 h-5 text-teal-400" /> Điều Khiển Quạt Thông Gió / Rơ-le (GPIO 25 / D25)
              </h2>
              <p className="text-sm text-slate-400">
                Gửi lệnh qua MQTT topic <code className="text-teal-300">command</code> và kích hoạt rơ-le trên ESP32.
              </p>
              {!canControl && <p className="text-sm text-amber-300">{VIEW_ONLY}</p>}
              {isDeviceDataHidden && (
                <p className="text-sm text-amber-300">
                  Không thể bật/tắt quạt khi thiết bị đang ở trạng thái {currentDev.lifecycle_status}.
                </p>
              )}

              <div className="flex gap-4 pt-4">
                <button 
                  onClick={() => handleCommand('ON')}
                  disabled={!canControl || isDeviceDataHidden}
                  title={!canControl ? VIEW_ONLY : undefined}
                  className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-emerald-600"
                >
                  <Power className="w-5 h-5" /> BẬT QUẠT
                </button>
                <button 
                  onClick={() => handleCommand('OFF')}
                  disabled={!canControl || isDeviceDataHidden}
                  title={!canControl ? VIEW_ONLY : undefined}
                  className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-red-600"
                >
                  <Power className="w-5 h-5" /> TẮT QUẠT
                </button>
              </div>
            </div>

            {/* Khối Cấu hình Tham số Từ xa (Remote Config - Đã thêm TVOC) */}
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-lg space-y-4">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Settings className="w-5 h-5 text-teal-400" /> Cấu Hình Tham Số Hoạt Động Từ Xa
              </h2>
              <form onSubmit={handleUpdateConfig} className="space-y-3">
                <fieldset disabled={!canControl || isDeviceDataHidden} title={!canControl ? VIEW_ONLY : undefined}
                  className="space-y-3 disabled:opacity-50">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-400">Chu kỳ gửi dữ liệu (ms):</label>
                    <input 
                      type="number" 
                      value={sendInterval} 
                      onChange={e => updateConfigField('send_interval_ms', e.target.value)}
                      min={1000} max={60000} required
                      className="w-full mt-1 p-2 bg-slate-800 border border-slate-700 rounded text-white text-sm" 
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400">Ngưỡng Nhiệt độ (°C):</label>
                    <input 
                      type="number" 
                      value={tempThreshold} 
                      onChange={e => updateConfigField('temp_threshold', e.target.value)}
                      step="any" required
                      className="w-full mt-1 p-2 bg-slate-800 border border-slate-700 rounded text-white text-sm" 
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-400">Ngưỡng eCO2 (ppm):</label>
                    <input 
                      type="number" 
                      value={eco2Threshold} 
                      onChange={e => updateConfigField('eco2_threshold', e.target.value)}
                      step="any" required
                      className="w-full mt-1 p-2 bg-slate-800 border border-slate-700 rounded text-white text-sm" 
                    />
                  </div>
                  <div>
                    <label className="text-xs text-teal-300 font-semibold">Ngưỡng TVOC (ppb):</label>
                    <input 
                      type="number" 
                      value={tvocThreshold} 
                      onChange={e => updateConfigField('tvoc_threshold', e.target.value)}
                      step="any" required
                      className="w-full mt-1 p-2 bg-slate-800 border border-teal-500 rounded text-white text-sm focus:outline-none" 
                    />
                  </div>
                </div>

                <button type="submit" className="w-full py-2 bg-teal-500 hover:bg-teal-600 text-white font-medium rounded text-sm transition mt-2">
                  Cập Nhật Ngưỡng Xuống ESP32
                </button>
                </fieldset>
              </form>
            </div>

            {/* Khối Quản lý Vòng đời (Chỉ Admin) */}
            {isAdmin && (
              <div className="bg-slate-900 border border-slate-800 p-6 rounded-lg md:col-span-2 space-y-4">
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  <Lock className="w-5 h-5 text-purple-400" /> Quản Lý Vòng Đời Thiết Bị (Device Lifecycle - Mục 4.4b)
                </h2>
                <div className="flex flex-wrap gap-3">
                  <button onClick={() => handleLifecycle('ACTIVE')} className="px-4 py-2 bg-emerald-900 border border-emerald-500 text-emerald-200 rounded text-sm">
                    Kích hoạt (ACTIVE)
                  </button>
                  <button onClick={() => handleLifecycle('MAINTENANCE')} className="px-4 py-2 bg-yellow-900 border border-yellow-500 text-yellow-200 rounded text-sm">
                    Bảo trì (MAINTENANCE)
                  </button>
                  <button onClick={() => handleLifecycle('DECOMMISSIONED')} className="px-4 py-2 bg-red-900 border border-red-500 text-red-200 rounded text-sm font-bold">
                    Thu hồi / Khóa (DECOMMISSIONED)
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: DANH SÁCH CẢNH BÁO (ALERTS) */}
        {tab === 'alerts' && (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex justify-between items-center">
              <h2 className="font-semibold text-white flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-400" /> Lịch Sử & Xử Lý Cảnh Báo (Mục 4.4d)
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="bg-slate-800/60 text-slate-400 text-xs uppercase">
                  <tr>
                    <th className="p-3">Thời gian</th>
                    <th className="p-3">Mức độ</th>
                    <th className="p-3">Nội dung</th>
                    <th className="p-3">Số đo</th>
                    <th className="p-3">Trạng thái</th>
                    <th className="p-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {alerts.map(a => (
                    <tr key={a.id} className="hover:bg-slate-800/30">
                      <td className="p-3 text-xs">{a.created_at}</td>
                      <td className="p-3">
                        <span className={`text-xs px-2 py-0.5 rounded font-bold ${
                          a.severity === 'CRITICAL' ? 'bg-red-900 text-red-300' : 'bg-yellow-900 text-yellow-300'
                        }`}>
                          {a.severity}
                        </span>
                      </td>
                      <td className="p-3">{a.message}</td>
                      <td className="p-3 font-semibold text-teal-300">{a.measured_value}</td>
                      <td className="p-3 text-xs">
                        {a.status === 'NEW' ? <span className="text-amber-400 font-bold">Mới</span> : <span className="text-slate-400">Đã xử lý</span>}
                      </td>
                      <td className="p-3 text-right">
                        {a.status === 'NEW' && canControl && (
                          <button 
                            onClick={() => handleAckAlert(a.id)} 
                            className="px-3 py-1 bg-teal-600 hover:bg-teal-700 text-white rounded text-xs"
                          >
                            Xác nhận xử lý
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {alerts.length === 0 && (
                    <tr><td colSpan="6" className="p-6 text-center text-slate-500">Không có cảnh báo nào!</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 4: QUẢN TRỊ & AUDIT LOGS */}
        {tab === 'audit' && isAdmin && (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <div className="p-4 border-b border-slate-800">
              <h2 className="font-semibold text-white flex items-center gap-2">
                <Shield className="w-5 h-5 text-purple-400" /> Nhật Ký Bảo Mật & Thao Tác Hệ Thống (Audit Logs - Mục 4.5)
              </h2>
            </div>
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-left text-sm text-slate-300">
                <thead className="bg-slate-800/60 text-slate-400 text-xs uppercase sticky top-0">
                  <tr>
                    <th className="p-3">Thời gian</th>
                    <th className="p-3">Người thực hiện</th>
                    <th className="p-3">Hành động</th>
                    <th className="p-3">Đối tượng</th>
                    <th className="p-3">Chi tiết</th>
                    <th className="p-3">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {auditLogs.map(log => (
                    <tr key={log.id} className="hover:bg-slate-800/30">
                      <td className="p-3 text-xs">{log.created_at}</td>
                      <td className="p-3 font-semibold text-purple-300">{log.username || 'Hệ thống'}</td>
                      <td className="p-3 font-mono text-xs text-amber-300">{log.action}</td>
                      <td className="p-3 text-xs">{log.target_entity}</td>
                      <td className="p-3 text-xs">{log.details}</td>
                      <td className="p-3 text-xs font-mono text-slate-400">{log.ip_address}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
