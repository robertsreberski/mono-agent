export interface ExtractedEntity {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

export interface ExtractedRelation {
  readonly src: string;
  readonly dst: string;
  readonly relation: string;
}
