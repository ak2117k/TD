import axios from 'axios';
import toast from 'react-hot-toast';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
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
