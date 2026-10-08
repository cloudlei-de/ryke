export type Unit = {
  id: string;
  name: string;
  symbol: string;
  toBase(v: number): number;
  fromBase(v: number): number;
};

export type Category = {
  id: string;
  name: string;
  base: string;
  units: Unit[];
};
