package org.openbooks.openbooksapi.core.model;

import org.openbooks.openbooksapi.core.repository.DoubleEntryAccountingEntryRepository;
import org.openbooks.openbooksapi.core.repository.TransactionRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import javax.persistence.EntityManager;
import javax.persistence.PersistenceContext;
import java.util.List;
import java.util.Optional;


public class DoubleEntryJournal implements Journal<DoubleEntryAccountingEntry> {

    @Autowired
    private TransactionRepository tranRepo;

    @Autowired
    private DoubleEntryAccountingEntryRepository entryRepo;

    @PersistenceContext
    private EntityManager entityMgr;

    @Override
    public DoubleEntryAccountingEntry commitAccountingEntry(DoubleEntryAccountingEntry entry) {
        // set the account for each transaction
        entry.getTransactionList().forEach(tran -> {
            Account parent = entityMgr.getReference(Account.class, tran.getAccountId());
            tran.setAccount(parent);
        });

        // return new object
        return entryRepo.save(entry);
    }

    @Transactional
    @Override
    public DoubleEntryAccountingEntry updateAccountingEntry(DoubleEntryAccountingEntry entry) {
        // update the account for each transaction
        entry.getTransactionList().forEach(tran -> {
            Account parent = entityMgr.getReference(Account.class, tran.getAccountId());
            tran.setAccount(parent);
        });

        // refresh entity and return updated object
        entityMgr.refresh(entryRepo.saveAndFlush(entry));
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

