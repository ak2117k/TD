import axios from 'axios';
import toast from 'react-hot-toast';

const api = axios.create({
  baseURL: '/api',
  // 30s: chart historical fetches chunk per trading day and pace 350ms
  // between Angel One calls (3 req/sec hard cap). A 7-day 15m view = 7
  // chunks = ~4-6s typical, but parallel fetches (candles + OI + quote
  // + fundamentals) can serialize behind the global pacer. 15s was too
  // tight — chart would time out and fall back to "demo data" even
  // though the backend was minutes away from a successful response.
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const message =
      error.response?.data?.message ||
      error.message ||
      'An unexpected error occurred';

    if (error.response?.status === 401) {
      toast.error('Session expired. Please re-authenticate.');
    } else if (error.response?.status === 429) {
      toast.error('Rate limit exceeded. Please wait.');
    } else if (error.response?.status && error.response.status >= 500) {
      toast.error(`Server error: ${message}`);
    }

    return Promise.reject(error);
  },
);

export default api;
