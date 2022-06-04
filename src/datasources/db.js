import mysql from 'mysql';
import config from '../config'

const pool = mysql.createPool(config.db)

export function query(queryString) {
    return new Promise((resolve, reject) => {
        pool.query(queryString, (error, results, fields) => {
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


