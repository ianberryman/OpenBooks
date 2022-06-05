
export interface IResolvers {
  api: {
    [key: string]: Function
  },
  type: {
    [key: string]: {
      [key: string]: Function
    }
  }
}