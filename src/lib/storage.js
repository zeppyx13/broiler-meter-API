import AsyncStorage from "@react-native-async-storage/async-storage";
const dotenv = require("dotenv");
dotenv.config();

const TOKEN_KEY = process.env.FCM_TOKEN_KEY;

export async function saveToken(token) {
  await AsyncStorage.setItem(TOKEN_KEY, token);
}

export async function getToken() {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function removeToken() {
  return AsyncStorage.removeItem(TOKEN_KEY);
}
