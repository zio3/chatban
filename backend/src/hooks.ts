// db層からアプリ層(要約生成など)へ通知するためのフック。循環importを避けるための置き場
// #60: 完了は常にバッチで通知する (単一done = 長さ1の配列)。要約再生成が更新1回につき1回で済む
export const hooks: {
  tasksCompleted: ((taskIds: number[]) => void) | null;
  taskReopened: ((taskId: number) => void) | null;
} = {
  tasksCompleted: null,
  taskReopened: null,
};
