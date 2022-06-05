import {ConsumerCustomer} from "../ConsumerCustomer/ConsumerCustomer";
import {BusinessCustomer} from "../BusinessCustomer/BusinessCustomer";


export type Customer = ConsumerCustomer | BusinessCustomer

export const typeDefs = `
  union Customer = ConsumerCustomer | BusinessCustomer
`