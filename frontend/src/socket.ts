import { io } from "socket.io-client";

// アプリ全体で共有するSocket.IO接続 (App/チャットフックが同じ接続にリスナーを張る)
export const socket = io();
