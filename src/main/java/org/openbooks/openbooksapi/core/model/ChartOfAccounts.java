package org.openbooks.openbooksapi.core.model;

import org.openbooks.openbooksapi.core.repository.AccountRepository;

import java.util.List;
import java.util.Optional;


public interface ChartOfAccounts {

    public AccountRepository getAccountsRepository();

    public List<Account> getAccounts();

    public Optional<Account> getAccountById(Long id);

    public List<Transaction> getTransactionsForAccount(Account account);

    public List<Account> getAccountsByAccountNumber(String accountNumber);

    public Account createAccount(Account account);

    public Account updateAccount(Account account);

    public void deleteAccount(Long id);
}
