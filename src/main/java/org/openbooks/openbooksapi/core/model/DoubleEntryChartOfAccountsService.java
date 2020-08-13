package org.openbooks.openbooksapi.core.model;

import org.openbooks.openbooksapi.core.repository.AccountRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.transaction.annotation.Transactional;

import javax.persistence.EntityManager;
import javax.persistence.EntityNotFoundException;
import javax.persistence.PersistenceContext;
import java.util.List;
import java.util.Optional;

/**
 * Manages {@link Account}-related data and implements any business
 * logic required between controllers and repositories.
 */
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
        // add account to parent company
        companies.getCompanyById(account.companyId).get().addAccount(account);

        return accountRepo.save(account);
    }

    @Transactional
    @Override
    public Account updateAccount(Account account) {
        // add account to parent company, may or may not have changed
        companies.getCompanyById(account.companyId).get().addAccount(account);

        // refresh object
        entityMgr.refresh(accountRepo.saveAndFlush(account));

        // return new object
        return accountRepo.getOne(account.getId());
    }

    @Override
    public void deleteAccount(Long id) {
        try {
            accountRepo.deleteById(id);

        // remap exception to standard type
        } catch  (EmptyResultDataAccessException e) {
            throw new EntityNotFoundException("Account with ID " + id + " not found");
        }
    }


}
