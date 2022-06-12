
import { Sequelize, Model } from 'sequelize'
import config from '../config'
import { v4 as uuidv4 } from 'uuid'

const sequelize = new Sequelize(config.db.database, config.db.user, config.db.password, {
    host: config.db.host,
    port: Number(config.db.port),
    dialect: 'mysql',
    // logging: false,
})

export default sequelize

sequelize.authenticate()
    .then(async () => {
        console.log('Database connected, synchronizing...')
        await sequelize.sync({ force: false })
        console.log('Sync finished')
    })
    .catch(err => console.error('Database failed to initialize. Double check your config and make sure `npm run init-db` completes successfully', err))


export function idToBuffer(id: string): Buffer {
    return Buffer.from(id, 'hex')
}

export function getId(fieldName: string, instance: Model): string {
    return Buffer.from(instance.getDataValue(fieldName)).toString('hex')
}

export function newId() {
    return Buffer.from(uuidv4().replace(/-/g, ''), 'hex')
}

export function setId(fieldName: string, id: string, instance: Model) {
    instance.setDataValue(fieldName, Buffer.from(id, 'hex'))
}

export function idModel() {
    return {
        type: 'BINARY(16)',
        primaryKey: true,
        defaultValue: newId,
        get() {
            return getId('id', this)
        },
    }
}

export function foreignKeyIdModel(keyName: string) {
    return {
        type: 'BINARY(16)',
        set(id: string) {
            setId(keyName, id, this)
        },
    // no getter, Sequelize needs the buffer value not string
    }
}
