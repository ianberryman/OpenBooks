import { DataSource }  from 'apollo-datasource';
import { query } from './db';
import NotFoundError from '../errors/NotFoundError';

export default class ContactPersonApi extends DataSource {
    context: any

    constructor() {
        super();
    }

    initialize(config) {
        this.context = config.context;
    }

    async getContactPersonById(id: string) {
      const results = await query("SELECT hex(id) as id, first_name, last_name, address_id, email, phone FROM contact_person WHERE id = unhex(?)", [id]);

      const contactPerson = results[0];
      if (!contactPerson) throw new NotFoundError("Contact Person with id: " + id + " not found");

      return {
        id: contactPerson.id,
        firstName: contactPerson.first_name,
        lastName: contactPerson.last_name,
        address_id: contactPerson.address_id,
        email: contactPerson.email,
        phone: contactPerson.phone,
      };
    }
}