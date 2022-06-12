import bcrypt from 'bcrypt'


export class Security {
    static hashPassword(rawPassword: string): string {
        return bcrypt.hashSync(rawPassword, 12)
    }

    static doesPasswordMatch(passwordHash: string, compareHash: string): boolean {
        return bcrypt.compareSync(passwordHash, compareHash)
    }
}