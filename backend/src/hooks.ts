// db層からアプリ層(要約生成など)へ通知するためのフック。循環importを避けるための置き場
export const hooks: {
  taskCompleted: ((taskId: number) => void) | null;
  taskReopened: ((taskId: number) => void) | null;
} = {
  taskCompleted: null,
  taskReopened: null,
};
