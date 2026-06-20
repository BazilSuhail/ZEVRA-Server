import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ unique: true, length: 32 })
  username!: string;

  @Index()
  @Column({ unique: true, length: 255 })
  email!: string;

  @Column({ length: 64 }) // srp_salt stored as hex
  srpSalt!: string;

  @Column({ nullable: true }) // srp_verifier computed during SRP protocol
  srpVerifier!: string | null;

  @Column({ type: 'json' }) // argon2_params for KEK derivation
  argon2Params!: {
    mem: number;
    t: number;
    p: number;
  };

  @Column({ default: 'active' })
  status!: string;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastPasswordChangeAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  keyVersion!: number | null;

  @Column({ type: 'json', nullable: true })
  senderKeys!: {
    groupId: string;
    senderId: string;
    receiverId: string;
    epoch: number;
    encryptedKey: string;
    keySignature: string;
  }[] | null;
}