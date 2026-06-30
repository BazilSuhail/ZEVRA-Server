import { RequestIdMiddleware } from '../../src/common/request-id.middleware';

describe('RequestIdMiddleware', () => {
  let middleware: RequestIdMiddleware;
  let mockReq: any;
  let mockRes: any;
  let mockNext: jest.Mock;

  beforeEach(() => {
    middleware = new RequestIdMiddleware();
    mockReq = { headers: {} };
    mockRes = {};
    mockNext = jest.fn();
  });

  it('generates UUID when no x-request-id header', () => {
    middleware.use(mockReq, mockRes, mockNext);

    expect(mockReq.headers['x-request-id']).toBeDefined();
    expect(mockReq.requestId).toBeDefined();
    expect(mockReq.headers['x-request-id']).toBe(mockReq.requestId);
    expect(mockNext).toHaveBeenCalled();
  });

  it('preserves existing x-request-id header', () => {
    mockReq.headers['x-request-id'] = 'existing-id-123';

    middleware.use(mockReq, mockRes, mockNext);

    expect(mockReq.headers['x-request-id']).toBe('existing-id-123');
    expect(mockReq.requestId).toBe('existing-id-123');
  });

  it('always calls next()', () => {
    middleware.use(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  it('generates unique IDs for each request', () => {
    const req1 = { headers: {} };
    const req2 = { headers: {} };

    middleware.use(req1, mockRes, mockNext);
    middleware.use(req2, mockRes, mockNext);

    expect(req1.headers['x-request-id']).not.toBe(req2.headers['x-request-id']);
  });
});
