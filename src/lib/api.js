import axios from "axios";
import { getToken } from "./storage";

export const api = axios.create({
  baseURL: "http://10.0.2.2:5000",
  timeout: 15000,
});

api.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
