import { api } from "../lib/api";
import { saveToken, removeToken } from "../lib/storage";

export async function register(payload) {
  const res = await api.post("/api/auth/register", payload);
  const token = res.data?.data?.token;
  if (token) await saveToken(token);
  return res.data;
}

export async function login(payload) {
  const res = await api.post("/api/auth/login", payload);
  const token = res.data?.data?.token;
  if (token) await saveToken(token);
  return res.data;
}

export async function me() {
  const res = await api.get("/api/auth/me");
  return res.data;
}

export async function logout() {
  await removeToken();
}
