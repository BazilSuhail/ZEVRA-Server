import { SocketAuthGuard } from '../../src/socket/socket-auth.guard';

describe('SocketAuthGuard', () => {
  let guard: SocketAuthGuard;
  let mockJwt: any;
  let mockDb: any;
  let mockClient: any;
  let mockContext: any;

  beforeEach(() => {
    mockJwt = { verifyAsync: jest.fn() };
    mockDb = { select: jest.fn().mockReturnThis(), from: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis() };
    guard = new SocketAuthGuard(mockJwt, mockDb);

    mockClient = {
      id: 'socket-123',
      handshake: { auth: {}, headers: {} },
      data: {},
      emit: jest.fn(),
      disconnect: jest.fn(),
    };

    mockContext = {
      switchToWs: () => ({
        getClient: () => mockClient,
      }),
    };
  });

  it('rejects when no token provided', async () => {
    const result = await guard.canActivate(mockContext);
    expect(result).toBe(false);
    expect(mockClient.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'NO_TOKEN' }));
    expect(mockClient.disconnect).toHaveBeenCalledWith(true);
  });

  it('extracts token from handshake.auth.token', async () => {
    mockClient.handshake.auth.token = 'my-token';
    mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1' });
    mockDb.where.mockResolvedValue([{ id: 'user-1', username: 'test', email: 'test@test.com', status: 'online' }]);

    expect(await guard.canActivate(mockContext)).toBe(true);
    expect(mockJwt.verifyAsync).toHaveBeenCalledWith('my-token');
  });

  it('extracts token from Authorization header', async () => {
    mockClient.handshake.headers.authorization = 'Bearer header-only-token';
    mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1' });
    mockDb.where.mockResolvedValue([{ id: 'user-1', username: 'test', email: 'test@test.com', status: 'online' }]);

    expect(await guard.canActivate(mockContext)).toBe(true);
    expect(mockJwt.verifyAsync).toHaveBeenCalledWith('header-only-token');
  });

  it('rejects expired token', async () => {
    mockClient.handshake.auth.token = 'expired-token';
    mockJwt.verifyAsync.mockRejectedValue({ name: 'TokenExpiredError' });

    expect(await guard.canActivate(mockContext)).toBe(false);
    expect(mockClient.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
  });

  it('rejects invalid token', async () => {
    mockClient.handshake.auth.token = 'bad-token';
    mockJwt.verifyAsync.mockRejectedValue({ name: 'JsonWebTokenError' });

    expect(await guard.canActivate(mockContext)).toBe(false);
    expect(mockClient.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('rejects when user not found', async () => {
    mockClient.handshake.auth.token = 'valid-token';
    mockJwt.verifyAsync.mockResolvedValue({ sub: 'nonexistent' });
    mockDb.where.mockResolvedValue([]);

    expect(await guard.canActivate(mockContext)).toBe(false);
    expect(mockClient.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'USER_NOT_FOUND' }));
  });

  it('prefers auth.token over Authorization header', async () => {
    mockClient.handshake.auth.token = 'auth-token';
    mockClient.handshake.headers.authorization = 'Bearer header-token';
    mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1' });
    mockDb.where.mockResolvedValue([{ id: 'user-1', username: 'test', email: 't@t.com', status: 'online' }]);

    await guard.canActivate(mockContext);
    expect(mockJwt.verifyAsync).toHaveBeenCalledWith('auth-token');
  });

  it('sets user on client.data', async () => {
    mockClient.handshake.auth.token = 'valid-token';
    const user = { id: 'user-1', username: 'test', email: 't@t.com', status: 'online' };
    mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1' });
    mockDb.where.mockResolvedValue([user]);

    await guard.canActivate(mockContext);
    expect(mockClient.data.user).toEqual(user);
  });
});
