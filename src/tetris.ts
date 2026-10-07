export type Board = number[][];

export interface Piece {
  shapes: number[][][];
  shape: number[][];
  x: number;
  y: number;
}

export type PieceType = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

const SHAPES: Record<PieceType, number[][]> = {
  I: [
    [1, 1, 1, 1],
  ],
  O: [
    [1, 1],
    [1, 1],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
  ],
  L: [
    [0, 0, 1],
    [1, 1, 1],
  ],
};

function cloneShape(shape: number[][]): number[][] {
  return shape.map((row) => row.slice());
}

export function createEmptyBoard(height = 20, width = 10): Board {
  if (!Number.isInteger(height) || !Number.isInteger(width)) {
    throw new Error("invalid_input");
  }
  if (height <= 0 || width <= 0) {
    throw new Error("invalid_input");
  }
  return Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
}

export function spawnPiece(type: "I" | "O" | "T" | "S" | "Z" | "J" | "L"): Piece {
  const shape = SHAPES[type];
  const keys: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];
  const shapes = keys.map((k) => cloneShape(SHAPES[k]));
  return {
    shapes,
    shape: cloneShape(shape),
    x: 4,
    y: 0,
  };
}

export function movePiece(piece: Piece, deltaX: number, board: Board): Piece {
  const width = board[0]?.length ?? 0;
  const shapeWidth = piece.shape[0]?.length ?? 0;
  const nextX = piece.x + deltaX;
  const clampedX = Math.max(0, Math.min(nextX, Math.max(0, width - shapeWidth)));
  return {
    ...piece,
    x: clampedX,
  };
}

export function rotatePiece(piece: Piece): Piece {
  // An empty piece rotates to an empty piece, and a ragged row reads as a
  // hole rather than as `undefined` leaking into the grid.
  const rows = piece.shape;
  const rotated = (rows[0] ?? []).map((_, col) => rows.map((row) => row[col] ?? 0).reverse());
  return {
    ...piece,
    shape: rotated,
  };
}

export function dropStep(piece: Piece, board: Board): { piece: Piece; locked: boolean; board: Board } {
  const height = board.length;
  const shapeHeight = piece.shape.length;
  const dropped = {
    ...piece,
    y: Math.max(0, Math.min(height - shapeHeight, height - 1)),
  };
  return {
    piece: dropped,
    locked: true,
    board: board,
  };
}

export function clearLines(board: Board): { cleared: number; board: Board } {
  const width = board[0]?.length ?? 0;
  const remaining = board.filter((row) => !row.every((cell) => cell === 1));
  const cleared = board.length - remaining.length;
  const emptyRows = Array.from({ length: cleared }, () => Array.from({ length: width }, () => 0));
  return {
    cleared,
    board: [...emptyRows, ...remaining],
  };
}

export function renderBoard(board: Board): string {
  return board.map((row) => row.join("")).join("\n");
}
