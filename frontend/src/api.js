import axios from 'axios';

const defaultApiBaseURL = import.meta.env.DEV
  ? 'http://127.0.0.1:8000'
  : 'https://iot-air-backend.onrender.com';
const baseURL = (import.meta.env.VITE_API_BASE_URL || defaultApiBaseURL) + '/api';

export function createApi(token) {
  return axios.create({
    baseURL,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeout: 10000,
  });
}

export function apiError(error, fallback) {
  const detail = error.response?.data?.detail;
  return typeof detail === 'string' ? detail : fallback;
}
