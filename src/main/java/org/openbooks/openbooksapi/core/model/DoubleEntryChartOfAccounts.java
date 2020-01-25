package org.openbooks.openbooksapi.core.model;

import org.openbooks.openbooksapi.core.repository.AccountRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import javax.persistence.EntityManager;
import javax.persistence.PersistenceContext;
import java.util.List;
import java.util.Optional;

public class DoubleEntryChartOfAccounts implements ChartOfAccounts {

    @Autowired
    private AccountRepository accountRepo;

    @Autowired
    private Journal journal;

    @PersistenceContext
    private EntityManager entityMgr;

    @Override
    public AccountRepository getAccountsRepository() {
        return accountRepo;
    }

    @Override
    public List<Account> getAccounts() {
        return accountRepo.findAll();
    }

    @Override
    public Optional<Account> getAccountById(Long id) {
        return accountRepo.findById(id);
    }

    @Override
    public List<Transaction> getTransactionsForAccount(Long id) {
        return journal.getTransactionsForAccount(id);
    }

    @Override
    public List<Account> getAccountsByAccountNumber(String accountNumber) {
        return accountRepo.findByAccountNumber(accountNumber);
    }

    @Override
    public Account createAccount(Account account) {
        return accountRepo.save(account);
    }

    @Transactional
    @Override
    public Account updateAccount(Account account) {
        // retrieve fields from DB where updatable = false
        entityMgr.refresh(accountRepo.saveAndFlush(account));
        // return new data
        return accountRepo.getOne(account.getId());
    }

    @Override
    public void deleteAccount(Long id) {
        accountRepo.deleteById(id);
    }


}
