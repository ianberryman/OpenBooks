
export interface IResolvers {
  api: {
    [key: string]: (...any) => any
  },
  type: {
    [key: string]: {
      [key: string]: (...any) => any
    }
  }
}