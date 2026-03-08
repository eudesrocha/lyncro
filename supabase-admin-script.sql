-- 1. Cria a tabela de perfis (se não existir)
create table if not exists public.profiles (
  id uuid references auth.users not null primary key,
  email text,
  role text default 'user', -- Papel padrão é 'user'
  -- Assinatura / Plano
  plan text default 'free',                    -- 'free' | 'pro'
  stripe_customer_id text,
  stripe_subscription_id text,
  plan_expires_at timestamptz
);

-- 1b. Adiciona colunas de assinatura caso a tabela já exista
alter table public.profiles
  add column if not exists plan text default 'free',
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists plan_expires_at timestamptz;

-- 2. Ativa o Row Level Security (RLS), o que significa que o acesso externo aos dados será bloqueado por padrão
alter table public.profiles enable row level security;

-- 3. Cria uma regra de política (Policy) permitindo que perfis possam visualizar a si próprios, e admins possam ver tudo
create policy "Usuários podem ver o próprio perfil" on profiles for select
  using ( auth.uid() = id );

create policy "Admins podem ver todos os perfis" on profiles for select
  using ( (select role from profiles where id = auth.uid()) = 'admin' );
  
-- 4. Cria a função (Trigger) que será executada sempre que um usuário fizer login/conta pela primeira vez
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, role, plan)
  values (
    new.id,
    new.email,
    -- Se o e-mail for o seu e-mail do Google, define como 'admin', senão define como 'user'
    case
      when new.email = 'eudesrocha1@yahoo.com.br' then 'admin'
      else 'user'
    end,
    'free' -- plano padrão para novos usuários
  );
  return new;
end;
$$ language plpgsql security definer;

-- 5. Anexa o Trigger ao sistema de Autenticação (Auth) do Supabase
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- IMPORTANTE: Se a sua conta Google tiver outro email que não seja eudesrocha1@yahoo.com.br, altere na linha 25.
-- TAMBÉM IMPORTANTE: Se a sua conta "eudesrocha1@yahoo.com.br" JÁ EXISTIR no sistema (você já logou), o trigger de "novo usuário" não vai rodar para ela. 
-- Nesse caso, rode esse comando extra abaixo separado para forçar ela a virar admin:

-- insert into public.profiles (id, email, role) 
-- select id, email, 'admin' from auth.users where email = 'eudesrocha1@yahoo.com.br'
-- on conflict (id) do update set role = 'admin';
