-- Ejecutar en el SQL Editor del proyecto Neon después de activar Auth y Data API.
CREATE TABLE IF NOT EXISTS public.user_data (
  user_id text PRIMARY KEY REFERENCES neon_auth."user"(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_data ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_data_select_own" ON public.user_data;
CREATE POLICY "user_data_select_own" ON public.user_data
  FOR SELECT TO authenticated
  USING ((SELECT auth.user_id()) = user_id);

DROP POLICY IF EXISTS "user_data_insert_own" ON public.user_data;
CREATE POLICY "user_data_insert_own" ON public.user_data
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.user_id()) = user_id);

DROP POLICY IF EXISTS "user_data_update_own" ON public.user_data;
CREATE POLICY "user_data_update_own" ON public.user_data
  FOR UPDATE TO authenticated
  USING ((SELECT auth.user_id()) = user_id)
  WITH CHECK ((SELECT auth.user_id()) = user_id);

DROP POLICY IF EXISTS "user_data_delete_own" ON public.user_data;
CREATE POLICY "user_data_delete_own" ON public.user_data
  FOR DELETE TO authenticated
  USING ((SELECT auth.user_id()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_data TO authenticated;
