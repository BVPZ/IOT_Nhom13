import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import mqtt from 'mqtt';
import { 
  Activity, Shield, Power, Settings, AlertTriangle, 
  FileText, LogOut, CheckCircle, RefreshCw, Wind, 
  Thermometer, Droplets, Cloud, Lock, Server, Wifi
} from 'lucide-react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, 
  Tooltip, ResponsiveContainer, Legend 
} from 'recharts';

// URL Backend API
const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'https://iot-air-backend.onrender.com') + '/api';

// Cấu hình WebSocket EMQX Cloud (WSS Port 8084)
const MQTT_WS_URL = 'wss://lebdf6ce.ala.asia-southeast1.emqxsl.com:8084/mqtt';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('user') || 'null'));
  
  // Login State
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
  const [mqttStatus, setMqttStatus] = useState('DISCONNECTED');

  // Remote Config State (Đã bổ sung TVOC)
  const [sendInterval, setSendInterval] = useState(5000);
  const [eco2Threshold, setEco2Threshold] = useState(1500);
  const [tempThreshold, setTempThreshold] = useState(35);
  const [tvocThreshold, setTvocThreshold] = useState(600); // Bổ sung ngưỡng TVOC

  const authHeader = { headers: { Authorization: `Bearer ${token}` } };
  const mqttClientRef = useRef(null);
  const lifecycleStatusRef = useRef({});
  const lastLoadedConfigRef = useRef('');

  useEffect(() => {
    lifecycleStatusRef.current = Object.fromEntries(
      devices.map(device => [device.device_code, device.lifecycle_status])
    );
  }, [devices]);

  useEffect(() => {
    const device = devices.find(item => item.device_code === selectedDevice);
    if (!device) return;

    const configVersion = [
      selectedDevice,
      device.send_interval_ms,
      device.eco2_threshold,
      device.temp_threshold,
      device.tvoc_threshold
    ].join(':');
    if (lastLoadedConfigRef.current === configVersion) return;
    lastLoadedConfigRef.current = configVersion;

    setSendInterval(device.send_interval_ms ?? 5000);
    setEco2Threshold(device.eco2_threshold ?? 1500);
    setTempThreshold(device.temp_threshold ?? 35);
    setTvocThreshold(device.tvoc_threshold ?? 600);
  }, [devices, selectedDevice]);

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
    if (mqttClientRef.current) {
      mqttClientRef.current.end();
    }
    setToken('');
    setUser(null);
    localStorage.clear();
  };

  // 2. TẢI DỮ LIỆU LỊCH SỬ TỪ AIVEN QUA API (CHẠY 1 LẦN KHI ĐĂNG NHẬP/CHỌN DEVICE)
  const fetchInitialData = async () => {
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

  // 3. KẾT NỐI REALTIME TRỰC TIẾP VỚI EMQX CLOUD QUA WEBSOCKET
  useEffect(() => {
    if (!token) return;

    fetchInitialData();

    // Tạo Client ID duy nhất để không bị đá session
    const clientId = `WEB_DASHBOARD_${Math.random().toString(16).substring(2, 8)}`;
    
    // Cấu hình tài khoản truy cập MQTT (sử dụng tài khoản EMQX của nhóm)
    const options = {
      clientId,
      username: 'frontend',   // Điền username EMQX 
      password: '123456', // Điền password EMQX 
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30 * 1000,
    };

    const client = mqtt.connect(MQTT_WS_URL, options);
    mqttClientRef.current = client;

    client.on('connect', () => {
      setMqttStatus('CONNECTED');
      // Đăng ký nhận dữ liệu cảm biến thời gian thực của thiết bị
      client.subscribe(`iot_nhom13/${selectedDevice}/telemetry`);
      client.subscribe(`iot_nhom13/${selectedDevice}/status`);
    });

    client.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        const now = new Date().toLocaleTimeString();

        // Xử lý gói tin Telemetry thời gian thực
        if (
          topic.includes('telemetry') &&
          !['MAINTENANCE', 'DECOMMISSIONED'].includes(lifecycleStatusRef.current[selectedDevice])
        ) {
          const newTemp = payload.temperature ?? payload.metrics?.temperature?.value ?? 0;
          const newHum = payload.humidity ?? payload.metrics?.humidity?.value ?? 0;
          const newEco2 = payload.eco2 ?? payload.metrics?.eco2?.value ?? 400;
          const newTvoc = payload.tvoc ?? payload.metrics?.tvoc?.value ?? 0;

          setTelemetry(prev => {
            const nextData = [...prev, {
              time: now,
              Temp: Number(newTemp),
              Hum: Number(newHum),
              eCO2: Number(newEco2),
              TVOC: Number(newTvoc)
            }];
            // Giữ tối đa 25 điểm trên biểu đồ
            if (nextData.length > 25) nextData.shift();
            return nextData;
          });
        }
      } catch (e) {
        console.error('Lỗi phân tích JSON từ MQTT:', e);
      }
    });

    client.on('error', (err) => {
      console.error('Lỗi kết nối MQTT:', err);
      setMqttStatus('ERROR');
    });

    client.on('close', () => {
      setMqttStatus('DISCONNECTED');
    });

    return () => {
      if (client) client.end();
    };
  }, [token, selectedDevice]);

  useEffect(() => {
    if (!token) return undefined;

    const refreshDeviceStatus = async () => {
      try {
        const response = await axios.get(`${API_BASE}/devices`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setDevices(response.data);
      } catch (err) {
        if (err.response?.status === 401) handleLogout();
        else console.error('Không thể cập nhật trạng thái thiết bị:', err);
      }
    };

    const intervalId = window.setInterval(refreshDeviceStatus, 5000);
    return () => window.clearInterval(intervalId);
  }, [token]);

  // 4. ĐIỀU KHIỂN & CẤU HÌNH THIẾT BỊ
  const handleCommand = async (action) => {
    setActionMsg('Đang gửi lệnh tới ESP32...');
    try {
      const res = await axios.post(`${API_BASE}/devices/${selectedDevice}/command`, 
        { target: 'FAN_RELAY', action }, authHeader
      );
      setActionMsg(`Thành công: ${res.data.message}`);
    } catch (err) {
      setActionMsg(`Lỗi (${err.response?.status}): ${err.response?.data?.detail}`);
    }
  };

  // Cập nhật cấu hình có bổ sung tvoc_threshold
  const handleUpdateConfig = async (e) => {
    e.preventDefault();
    setActionMsg('Đang gửi cấu hình mới xuống ESP32...');
    try {
      const res = await axios.put(`${API_BASE}/devices/${selectedDevice}/config`, {
        send_interval_ms: Number(sendInterval),
        eco2_threshold: Number(eco2Threshold),
        temp_threshold: Number(tempThreshold),
        tvoc_threshold: Number(tvocThreshold) // Gửi ngưỡng TVOC
      }, authHeader);
      const savedConfig = res.data.config;
      if (savedConfig) {
        setSendInterval(savedConfig.send_interval_ms);
        setEco2Threshold(savedConfig.eco2_threshold);
        setTempThreshold(savedConfig.temp_threshold);
        setTvocThreshold(savedConfig.tvoc_threshold);
        setDevices(prev => prev.map(device => (
          device.device_code === selectedDevice
            ? { ...device, ...savedConfig }
            : device
        )));
      }
      setActionMsg(`Thành công: ${res.data.message || 'Đã áp dụng cấu hình'}`);
    } catch (err) {
      setActionMsg(`Lỗi: ${err.response?.data?.detail || 'Không thể cập nhật'}`);
    }
  };

  const handleLifecycle = async (status) => {
    if (!window.confirm(`Xác nhận đổi trạng thái thiết bị sang ${status}?`)) return;
    try {
      await axios.put(`${API_BASE}/devices/${selectedDevice}/lifecycle`, 
        { lifecycle_status: status }, authHeader
      );
      lifecycleStatusRef.current[selectedDevice] = status;
      setDevices(prev => prev.map(device => (
        device.device_code === selectedDevice
          ? {
              ...device,
              lifecycle_status: status,
              is_online: status === 'ACTIVE' ? device.is_online : 0
            }
          : device
      )));
      if (['MAINTENANCE', 'DECOMMISSIONED'].includes(status)) {
        setTelemetry([]);
      }
      setActionMsg(`Đã chuyển thiết bị sang trạng thái: ${status}`);
      fetchInitialData();
    } catch (err) {
      setActionMsg(`Lỗi: ${err.response?.data?.detail}`);
    }
  };

  const handleAckAlert = async (id) => {
    try {
      await axios.put(`${API_BASE}/alerts/${id}/acknowledge`, 
        { resolve_note: 'Đã kiểm tra và xử lý thông gió phòng' }, authHeader
      );
      fetchInitialData();
    } catch (err) {
      alert(err.response?.data?.detail || 'Lỗi xử lý cảnh báo');
    }
  };

  const latest = telemetry[telemetry.length - 1] || { Temp: 0, Hum: 0, eCO2: 400, TVOC: 0 };
  const currentDev = devices.find(d => d.device_code === selectedDevice) || {};
  const isDeviceDataHidden = ['MAINTENANCE', 'DECOMMISSIONED'].includes(currentDev.lifecycle_status);

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
          {/* Trạng thái kết nối WebSocket MQTT */}
          <div className="flex items-center gap-1.5 text-xs bg-slate-800 border border-slate-700 px-3 py-1 rounded">
            <Wifi className={`w-3.5 h-3.5 ${mqttStatus === 'CONNECTED' ? 'text-emerald-400' : 'text-amber-400'}`} />
            <span title="Kết nối MQTT của trình duyệt dashboard, không phải trạng thái online của ESP32">MQTT Web: </span>
            <strong className={mqttStatus === 'CONNECTED' ? 'text-emerald-400' : 'text-amber-400'}>
              {mqttStatus}
            </strong>
          </div>

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
          <Activity className="w-4 h-4" /> Giám Sát Thời Gian Thực (MQTT)
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
                <Activity className="w-5 h-5 text-teal-400" /> Biểu Đồ Diễn Biến Không Khí (MQTT Live Stream)
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
                    <Line yAxisId="left" type="monotone" dataKey="TVOC" name="TVOC (ppb)" stroke="#2dd4bf" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          )
        )}

        {/* TAB 2: ĐIỀU KHIỂN & CẤU HÌNH THIẾT BỊ (CONTROL & CONFIG) */}
        {activeTab === 'control' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Khối Điều khiển Quạt */}
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-lg space-y-4">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Power className="w-5 h-5 text-teal-400" /> Điều Khiển Quạt Thông Gió / Rơ-le (GPIO 25 / D25)
              </h2>
              <p className="text-sm text-slate-400">
                Gửi lệnh qua MQTT topic <code className="text-teal-300">command</code> và kích hoạt rơ-le trên ESP32.
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

            {/* Khối Cấu hình Tham số Từ xa (Remote Config - Đã thêm TVOC) */}
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-lg space-y-4">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Settings className="w-5 h-5 text-teal-400" /> Cấu Hình Tham Số Hoạt Động Từ Xa
              </h2>
              <form onSubmit={handleUpdateConfig} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
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
                    <label className="text-xs text-slate-400">Ngưỡng Nhiệt độ (°C):</label>
                    <input 
                      type="number" 
                      value={tempThreshold} 
                      onChange={e => setTempThreshold(e.target.value)}
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
                      onChange={e => setEco2Threshold(e.target.value)}
                      className="w-full mt-1 p-2 bg-slate-800 border border-slate-700 rounded text-white text-sm" 
                    />
                  </div>
                  <div>
                    <label className="text-xs text-teal-300 font-semibold">Ngưỡng TVOC (ppb):</label>
                    <input 
                      type="number" 
                      value={tvocThreshold} 
                      onChange={e => setTvocThreshold(e.target.value)}
                      className="w-full mt-1 p-2 bg-slate-800 border border-teal-500 rounded text-white text-sm focus:outline-none" 
                    />
                  </div>
                </div>

                <button type="submit" className="w-full py-2 bg-teal-500 hover:bg-teal-600 text-white font-medium rounded text-sm transition mt-2">
                  Cập Nhật Ngưỡng Xuống ESP32
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

        {/* TAB 4: QUẢN TRỊ & AUDIT LOGS */}
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