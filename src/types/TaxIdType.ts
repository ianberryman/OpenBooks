

export enum TaxIdType {
  SSN = 'SSN',
  EIN = 'EIN',
}

export const typeDefs = `
  enum TaxIdType {
    ${Object.keys(TaxIdType).join('\n')}
  }
`