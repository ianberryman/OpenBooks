

export enum QuantityUnit {
  Each = 'Each',
  Pound = 'Pound',
}

export const typeDefs = `
  enum QuantityUnit {
    ${Object.keys(QuantityUnit).join('\n')}
  }
`