import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { 
  Activity, Shield, Power, Settings, AlertTriangle, 
  FileText, LogOut, CheckCircle, RefreshCw, Wind, 
  Thermometer, Droplets, Cloud, Lock, Server
} from 'lucide-react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, 
  Tooltip, ResponsiveContainer, Legend 
} from 'recharts';

const API_BASE = 'http://localhost:8000/api';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('user') || 'null'));
  
  // Login State
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('123456');
  const [loginError, setLoginError] = useState('');

  // Dashboard State
  const [activeTab, setActiveTab] = useState('monitoring');
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('ESP32_NODE_01');
  const [telemetry, setTelemetry] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [commands, setCommands] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [actionMsg, setActionMsg] = useState('');

  // Remote Config State
  const [sendInterval, setSendInterval] = useState(5000);
  const [eco2Threshold, setEco2Threshold] = useState(1000);
  const [tempThreshold, setTempThreshold] = useState(35);

  const authHeader = { headers: { Authorization: `Bearer ${token}` } };

  // 1. XỬ LÝ ĐĂNG NHẬP / ĐĂNG XUẤT
  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await axios.post(`${API_BASE}/auth/login`, { username, password });
      setToken(res.data.access_token);
      setUser(res.data.user);
      localStorage.setItem('token', res.data.access_token);
      localStorage.setItem('user', JSON.stringify(res.data.user));
    } catch (err) {
      setLoginError(err.response?.data?.detail || 'Đăng nhập thất bại!');
    }
  };

  const handleLogout = () => {
    setToken('');
    setUser(null);
    localStorage.clear();
  };

  // 2. TỰ ĐỘNG CẬP NHẬT DỮ LIỆU ĐỊNH KỲ (POLLING MỖI 3S)
  const fetchData = async () => {
    if (!token) return;
    try {
      const [devRes, teleRes, alertRes] = await Promise.all([
        axios.get(`${API_BASE}/devices`, authHeader),
        axios.get(`${API_BASE}/devices/${selectedDevice}/telemetry?limit=25`, authHeader),
        axios.get(`${API_BASE}/alerts`, authHeader)
      ]);
      setDevices(devRes.data);
      setTelemetry(teleRes.data.map(d => ({
        time: d.recorded_at ? d.recorded_at.split(' ')[1] || d.recorded_at : '',
        Temp: d.temperature,
        Hum: d.humidity,
        eCO2: d.eco2,
        TVOC: d.tvoc
      })));
      setAlerts(alertRes.data);

      if (user?.role === 'ADMIN') {
        const [cmdRes, auditRes] = await Promise.all([
          axios.get(`${API_BASE}/commands`, authHeader),
          axios.get(`${API_BASE}/audit-logs`, authHeader)
        ]);
        setCommands(cmdRes.data);
        setAuditLogs(auditRes.data);
      }
    } catch (err) {
      if (err.response?.status === 401) handleLogout();
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [token, selectedDevice]);

  // 3. CÁC HÀM TƯƠNG TÁC ĐIỀU KHIỂN & VÒNG ĐỜI
  const handleCommand = async (action) => {
    setActionMsg('Đang gửi lệnh tới ESP32...');
    try {
      const res = await axios.post(`${API_BASE}/devices/${selectedDevice}/command`, 
        { target: 'FAN_RELAY', action }, authHeader
      );
      setActionMsg(`Thành công: ${res.data.message}`);
      fetchData();
    } catch (err) {
      setActionMsg(`Lỗi (${err.response?.status}): ${err.response?.data?.detail}`);
    }
  };

  const handleUpdateConfig = async (e) => {
    e.preventDefault();
    setActionMsg('Đang cập nhật cấu hình...');
    try {
      const res = await axios.put(`${API_BASE}/devices/${selectedDevice}/config`, {
        send_interval_ms: Number(sendInterval),
        eco2_threshold: Number(eco2Threshold),
        temp_threshold: Number(tempThreshold)
      }, authHeader);
      setActionMsg(`Thành công: ${res.data.message}`);
    } catch (err) {
      setActionMsg(`Lỗi: ${err.response?.data?.detail}`);
    }
  };

  const handleLifecycle = async (status) => {
    if (!window.confirm(`Xác nhận đổi trạng thái thiết bị sang ${status}?`)) return;
    try {
      await axios.put(`${API_BASE}/devices/${selectedDevice}/lifecycle`, 
        { lifecycle_status: status }, authHeader
      );
      setActionMsg(`Đã chuyển thiết bị sang trạng thái: ${status}`);
      fetchData();
    } catch (err) {
      setActionMsg(`Lỗi: ${err.response?.data?.detail}`);
    }
  };

  const handleAckAlert = async (id) => {
    try {
      await axios.put(`${API_BASE}/alerts/${id}/acknowledge`, 
        { resolve_note: 'Đã kiểm tra và xử lý thông gió phòng' }, authHeader
      );
      fetchData();
    } catch (err) {
      alert(err.response?.data?.detail || 'Lỗi xử lý cảnh báo');
    }
  };

  // Lấy dữ liệu mới nhất
  const latest = telemetry[telemetry.length - 1] || { Temp: 0, Hum: 0, eCO2: 400, TVOC: 0 };
  const currentDev = devices.find(d => d.device_code === selectedDevice) || {};

  // =========================================================================
  // GIAO DIỆN 1: MÀN HÌNH ĐĂNG NHẬP
  // =========================================================================
  if (!token) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 max-w-md w-full shadow-2xl">
          <div className="text-center mb-8">
            <Activity className="w-12 h-12 text-teal-400 mx-auto mb-2" />
            <h1 className="text-2xl font-bold text-white">Hệ Thống Giám Sát Không Khí</h1>
            <p className="text-slate-400 text-sm mt-1">Đồ Án IoT & Ứng Dụng - Nhóm 13</p>
          </div>

          {loginError && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded text-red-200 text-sm">
              {loginError}
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="text-slate-300 text-sm font-medium">Tên đăng nhập</label>
              <input 
                type="text" 
                value={username} 
                onChange={(e) => setUsername(e.target.value)}
                className="w-full mt-1 p-3 bg-slate-900 border border-slate-700 rounded text-white focus:outline-none focus:border-teal-500" 
                required 
              />
            </div>
            <div>
              <label className="text-slate-300 text-sm font-medium">Mật khẩu</label>
              <input 
                type="password" 
                value={password} 
                onChange={(e) => setPassword(e.target.value)}
                className="w-full mt-1 p-3 bg-slate-900 border border-slate-700 rounded text-white focus:outline-none focus:border-teal-500" 
                required 
              />
            </div>
            <button 
              type="submit" 
              className="w-full py-3 bg-teal-500 hover:bg-teal-600 text-white font-semibold rounded transition"
            >
              Đăng Nhập
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-slate-700 text-xs text-slate-400">
            <p className="font-semibold text-slate-300 mb-1">Tài khoản demo sẵn (Pass: 123456):</p>
            <div className="flex justify-between">
              <button onClick={() => setUsername('admin')} className="text-teal-400 hover:underline">Admin (Toàn quyền)</button>
              <button onClick={() => setUsername('operator')} className="text-teal-400 hover:underline">Operator (Vận hành)</button>
              <button onClick={() => setUsername('viewer')} className="text-teal-400 hover:underline">Viewer (Xem)</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // GIAO DIỆN 2: DASHBOARD CHÍNH
  // =========================================================================
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
          <div className="text-right">
            <span className="text-sm font-medium text-white">{user?.full_name}</span>
            <div className="flex items-center justify-end gap-1">
              <span className={`text-xs px-2 py-0.5 rounded font-bold ${
                user?.role === 'ADMIN' ? 'bg-purple-900 text-purple-300' : 
                user?.role === 'OPERATOR' ? 'bg-blue-900 text-blue-300' : 'bg-slate-800 text-slate-300'
              }`}>
                {user?.role}
              </span>
            </div>
          </div>
          <button 
            onClick={handleLogout} 
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
      <div className="bg-slate-900/50 border-b border-slate-800 px-6 flex gap-6 text-sm font-medium">
        <button 
          onClick={() => setActiveTab('monitoring')} 
          className={`py-3 border-b-2 flex items-center gap-2 ${activeTab === 'monitoring' ? 'border-teal-400 text-teal-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
        >
          <Activity className="w-4 h-4" /> Giám Sát Thời Gian Thực
        </button>
        <button 
          onClick={() => setActiveTab('control')} 
          className={`py-3 border-b-2 flex items-center gap-2 ${activeTab === 'control' ? 'border-teal-400 text-teal-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
        >
          <Power className="w-4 h-4" /> Điều Khiển & Cấu Hình
        </button>
        <button 
          onClick={() => setActiveTab('alerts')} 
          className={`py-3 border-b-2 flex items-center gap-2 ${activeTab === 'alerts' ? 'border-teal-400 text-teal-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
        >
          <AlertTriangle className="w-4 h-4" /> Cảnh Báo ({alerts.filter(a => a.status === 'NEW').length})
        </button>
        {user?.role === 'ADMIN' && (
          <button 
            onClick={() => setActiveTab('audit')} 
            className={`py-3 border-b-2 flex items-center gap-2 ${activeTab === 'audit' ? 'border-teal-400 text-teal-400' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
          >
            <Shield className="w-4 h-4" /> Quản Trị & Audit Logs
          </button>
        )}
      </div>

      {/* Tab Content Area */}
      <main className="p-6 flex-1 overflow-auto space-y-6">
        
        {/* Device Status Bar */}
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
          </div>
        </div>

        {/* TAB 1: GIÁM SÁT THỜI GIAN THỰC (MONITORING) */}
        {activeTab === 'monitoring' && (
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
                latest.eCO2 > 1000 ? 'bg-red-950/20 border-red-800' : 'bg-slate-900 border-slate-800'
              }`}>
                <div>
                  <p className="text-slate-400 text-xs uppercase font-medium">Khí eCO2 (CCS811)</p>
                  <p className={`text-3xl font-bold mt-1 ${latest.eCO2 > 1000 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {latest.eCO2} <span className="text-sm font-normal text-slate-400">ppm</span>
                  </p>
                </div>
                <Cloud className={`w-10 h-10 p-2 rounded-lg ${latest.eCO2 > 1000 ? 'text-red-400 bg-red-950/50' : 'text-emerald-400 bg-emerald-950/40'}`} />
              </div>

              <div className="bg-slate-900 border border-slate-800 p-5 rounded-lg flex items-center justify-between">
                <div>
                  <p className="text-slate-400 text-xs uppercase font-medium">Khí TVOC (CCS811)</p>
                  <p className="text-3xl font-bold text-teal-400 mt-1">{latest.TVOC} <span className="text-sm font-normal text-slate-400">ppb</span></p>
                </div>
                <Wind className="w-10 h-10 text-teal-400 bg-teal-950/40 p-2 rounded-lg" />
              </div>
            </div>

            {/* Biểu đồ Thời gian thực (Recharts) */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-lg">
              <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
                <Activity className="w-5 h-5 text-teal-400" /> Biểu Đồ Diễn Biến Chất Lượng Không Khí (Realtime)
              </h2>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={telemetry}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="time" stroke="#94a3b8" />
                    <YAxis yAxisId="left" stroke="#38bdf8" />
                    <YAxis yAxisId="right" orientation="right" stroke="#34d399" />
                    <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155' }} />
                    <Legend />
                    <Line yAxisId="left" type="monotone" dataKey="Temp" name="Nhiệt độ (°C)" stroke="#fb923c" strokeWidth={2} dot={false} />
                    <Line yAxisId="left" type="monotone" dataKey="Hum" name="Độ ẩm (%)" stroke="#38bdf8" strokeWidth={2} dot={false} />
                    <Line yAxisId="right" type="monotone" dataKey="eCO2" name="eCO2 (ppm)" stroke="#34d399" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: ĐIỀU KHIỂN & CẤU HÌNH THIẾT BỊ (CONTROL & CONFIG) */}
        {activeTab === 'control' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Khối Điều khiển Quạt / Cơ cấu chấp hành */}
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-lg space-y-4">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Power className="w-5 h-5 text-teal-400" /> Điều Khiển Quạt Thông Gió / Rơ-le (GPIO 2)
              </h2>
              <p className="text-sm text-slate-400">
                Gửi lệnh qua MQTT topic <code className="text-teal-300">command</code> và chờ phản hồi xác nhận <code className="text-teal-300">ack</code> từ ESP32.
              </p>

              <div className="flex gap-4 pt-4">
                <button 
                  onClick={() => handleCommand('ON')}
                  className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded flex items-center justify-center gap-2"
                >
                  <Power className="w-5 h-5" /> BẬT QUẠT
                </button>
                <button 
                  onClick={() => handleCommand('OFF')}
                  className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded flex items-center justify-center gap-2"
                >
                  <Power className="w-5 h-5" /> TẮT QUẠT
                </button>
              </div>
            </div>

            {/* Khối Cấu hình Tham số Từ xa (Remote Config) */}
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-lg space-y-4">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Settings className="w-5 h-5 text-teal-400" /> Cấu Hình Tham Số Hoạt Động Từ Xa
              </h2>
              <form onSubmit={handleUpdateConfig} className="space-y-3">
                <div>
                  <label className="text-xs text-slate-400">Chu kỳ gửi dữ liệu (ms):</label>
                  <input 
                    type="number" 
                    value={sendInterval} 
                    onChange={e => setSendInterval(e.target.value)}
                    className="w-full mt-1 p-2 bg-slate-800 border border-slate-700 rounded text-white text-sm" 
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400">Ngưỡng cảnh báo eCO2 (ppm):</label>
                  <input 
                    type="number" 
                    value={eco2Threshold} 
                    onChange={e => setEco2Threshold(e.target.value)}
                    className="w-full mt-1 p-2 bg-slate-800 border border-slate-700 rounded text-white text-sm" 
                  />
                </div>
                <button type="submit" className="w-full py-2 bg-teal-500 hover:bg-teal-600 text-white font-medium rounded text-sm transition">
                  Cập Nhật Xuống ESP32
                </button>
              </form>
            </div>

            {/* Khối Quản lý Vòng đời (Chỉ Admin) */}
            {user?.role === 'ADMIN' && (
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
                <p className="text-xs text-slate-400">
                  *Khi chuyển sang <strong className="text-red-400">DECOMMISSIONED</strong>, Backend sẽ từ chối lưu Telemetry và từ chối lệnh điều khiển để phục vụ Demo bước 10.
                </p>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: DANH SÁCH CẢNH BÁO (ALERTS) */}
        {activeTab === 'alerts' && (
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
                        {a.status === 'NEW' && user?.role !== 'VIEWER' && (
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

        {/* TAB 4: QUẢN TRỊ & NHẬT KÝ BẢO MẬT (AUDIT LOGS - CHỈ ADMIN) */}
        {activeTab === 'audit' && user?.role === 'ADMIN' && (
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