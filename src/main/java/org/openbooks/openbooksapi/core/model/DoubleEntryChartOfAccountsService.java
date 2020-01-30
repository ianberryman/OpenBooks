package org.openbooks.openbooksapi.core.model;

import org.openbooks.openbooksapi.core.repository.AccountRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import javax.persistence.EntityManager;
import javax.persistence.PersistenceContext;
import java.util.List;
import java.util.Optional;

public class DoubleEntryChartOfAccountsService implements ChartOfAccountsService {

    @Autowired
    private AccountRepository accountRepo;

    @Autowired
    private JournalService journal;

    @Autowired
    private CompanyService companies;

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
    public boolean accountExists(Account account) {
        return accountRepo.existsById(account.getId());
    }

    @Override
    public List<Transaction> getTransactionsForAccount(Account account) {
        return journal.getTransactionsForAccount(account);
    }

    @Override
    public List<Account> getAccountsByAccountNumber(String accountNumber) {
        return accountRepo.findByAccountNumber(accountNumber);
    }

    @Override
    public List<Account> getAccountsByCompany(Company company) {
        return accountRepo.findByCompany(company);
    }

    @Override
    public Account createAccount(Account account) {
        companies.getCompanyById(account.companyId).get().addAccount(account);

        return accountRepo.save(account);
    }

    @Transactional
    @Override
    public Account updateAccount(Account account) {
        companies.getCompanyById(account.companyId).get().addAccount(account);
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
