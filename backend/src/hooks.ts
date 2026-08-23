// db層からアプリ層(Done列の畳み直し)へ通知するためのフック。循環importを避けるための置き場
// #60: 完了は常にバッチで通知する (単一done = 長さ1の配列)。畳み直しが更新1回につき1回で済む
export const hooks: {
  cardsCompleted: ((cardIds: number[]) => void) | null;
  cardReopened: ((cardId: number) => void) | null;
} = {
  cardsCompleted: null,
  cardReopened: null,
};

