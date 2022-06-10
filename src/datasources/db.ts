import mysql from 'mysql'
import config from '../config'
import { v4 as uuidv4 } from 'uuid'

const pool = mysql.createPool(config.db)
export default pool

export function query(
    queryString: string,
    values: Array<any> | { [key: string]: any} = []
): Promise<Array<any>> {
    return new Promise((resolve, reject) => {
        pool.query(queryString, values, (error, results, fields) => {
            if (error) {
                console.log(error)
                reject(error)
            }
            if (results) {
                resolve(results)
            }
        })
    })
}

export function newId() {
    return uuidv4().replace(/-/g, '')
}


