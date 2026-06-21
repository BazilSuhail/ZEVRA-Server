import { Module, Global } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE = 'SUPABASE_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: SUPABASE,
      useFactory: (): SupabaseClient => {
        return createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_ANON_KEY!,
          {
            realtime: {
              params: {
                eventsPerSecond: 10,
              },
            },
          },
        );
      },
    },
  ],
  exports: [SUPABASE],
})
export class SupabaseModule {}
