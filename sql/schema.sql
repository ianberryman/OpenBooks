
create table if not exists accounttype (
    account_type varchar(20) not null,

    constraint pk_accounttype primary key (account_type)
);

insert into accounttype
values ('Income'), 
       ('Expense'),
       ('Asset'),
       ('Liability'),
       ('Equity')
ON CONFLICT DO NOTHING;

create table if not exists account (
    id uuid not null,
    account_name varchar(100) not null,
    account_type varchar(20) not null,
    balance decimal(15,2) not null default 0,
    is_system_account boolean not null,

    constraint pk_account primary key (id),
    constraint fk_account_accounttype foreign key (account_type)
    references accounttype (account_type)
);