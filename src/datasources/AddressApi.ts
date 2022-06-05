import { DataSource }  from 'apollo-datasource';
import { query } from './db';
import NotFoundError from '../errors/NotFoundError';

export default class AddressApi extends DataSource {
    context: any

    constructor() {
        super();
    }

    initialize(config) {
        this.context = config.context;
    }

    async getAddressById(id: string) {
      const results = await query("SELECT hex(id) as id, line1, line2, city, state, zipcode, country FROM address WHERE id = unhex(?)", [id]);

      const address = results[0];
      if (!address) throw new NotFoundError("Address with ID " + id + " not found");

      return {
        id: address.id,
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        state: address.state,
        zipcode: address.zipcode,
        country: address.country,
      };
    }
}