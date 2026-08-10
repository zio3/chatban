import { io } from "socket.io-client";
import { projectIdFromUrl } from "./project";

// アプリ全体で共有するSocket.IO接続 (App/チャットフックが同じ接続にリスナーを張る)。
// #97/#99: 表示中のプロジェクトを接続時に固定する。サーバー側はプロジェクト単位のroomへ配信するので、
// タブごとに別プロジェクトを開いても他方の更新は届かない
const projectId = projectIdFromUrl();
export const socket = io(projectId ? { query: { project: projectId } } : {});
