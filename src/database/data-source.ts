import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.SUPABASE_URL || 'postgresql://postgres:postgres@db.postgres.supabase.com:5432/postgres',
  ssl: {
    rejectUnauthorized: false,
  },
  entities: [User],
  synchronize: false,
  logging: true,
});