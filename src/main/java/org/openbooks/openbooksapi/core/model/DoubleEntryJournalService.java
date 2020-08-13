package org.openbooks.openbooksapi.core.model;

import org.openbooks.openbooksapi.core.error.UnbalancedAccountingEntryException;
import org.openbooks.openbooksapi.core.repository.DoubleEntryAccountingEntryRepository;
import org.openbooks.openbooksapi.core.repository.TransactionRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import javax.persistence.EntityManager;
import javax.persistence.PersistenceContext;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.List;
import java.util.Optional;


public class DoubleEntryJournalService implements JournalService<DoubleEntryAccountingEntry> {

    @Autowired
    private TransactionRepository tranRepo;

    @Autowired
    private DoubleEntryAccountingEntryRepository entryRepo;

    @PersistenceContext
    private EntityManager entityMgr;

    @Override
    public DoubleEntryAccountingEntry commitAccountingEntry(DoubleEntryAccountingEntry entry)
            throws UnbalancedAccountingEntryException {
        if (!entry.isBalanced()) {
            throw new UnbalancedAccountingEntryException("Accounting Entry is out of balance and can't be saved");
        }

        // set the account and accounting entry for each transaction
        entry.getTransactionList().forEach(tran -> {
            Account parent = entityMgr.getReference(Account.class, tran.accountId);
            tran.setAccount(parent);
            tran.setAccountingEntry(entry);
        });

        // save and return new object
        return entryRepo.save(entry);
    }

    @Transactional
    @Override
    public DoubleEntryAccountingEntry updateAccountingEntry(DoubleEntryAccountingEntry entry)
            throws UnbalancedAccountingEntryException {
        if (!entry.isBalanced()) {
            throw new UnbalancedAccountingEntryException("Accounting Entry is out of balance and can't be saved");
        }

        // update the account for each transaction
        entry.getTransactionList().forEach(tran -> {
            Account parent = entityMgr.getReference(Account.class, tran.accountId);
            tran.setAccount(parent);
        });

        // refresh entity
        entityMgr.refresh(entryRepo.saveAndFlush(entry));

        // return updated object
        return entryRepo.getOne(entry.getId());
    }

    @Transactional
    @Override
    public List<DoubleEntryAccountingEntry> getAccountingEntries() {
        return entryRepo.findAll();
    }

    @Override
    public Optional<DoubleEntryAccountingEntry> getAccountingEntryById(Long entryId) {
        return entryRepo.findById(entryId);
    }



    @Override
    public List<Transaction> getTransactionsForAccount(Account account) {
        return tranRepo.findAllByAccount(account);
    }

    @Override
    public Optional<Transaction> getTransactionById(Long id) {
        return tranRepo.findById(id);
    }
}

