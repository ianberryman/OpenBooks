package org.openbooks.openbooksapi.core.controller;

import org.openbooks.openbooksapi.core.model.Journal;
import org.openbooks.openbooksapi.core.model.Transaction;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.Optional;

@RestController
public class TransactionController {

    @Autowired
    private Journal journal;

    @GetMapping("/transactions/{id}")
    public Optional<Transaction> getTransactionById(@PathVariable Long id) {

        return journal.getTransactionById(id);
    }

/*    @PostMapping("/transactions")
    public ResponseEntity<Transaction> createTransaction(@RequestBody Transaction transaction) {
        // throw error if transaction exists
        if (!transaction.idIsNull() && journal.getTransactionById(transaction.getId()).isPresent()) {
            throw new EntityExistsException("Transaction with ID " + transaction.getId() + " already exists");
        }

        // persist updates and return new object
        return ResponseEntity.ok().body(journal.commitTransaction(transaction));
    }

    @PutMapping("/transactions")
    public ResponseEntity<Transaction> updateTransaction(@RequestBody Transaction transaction) {
        // check if id exists, will throw error if account doesn't exist
        getTransactionById(transaction.getId());

        // persist updates and return updated object
        return ResponseEntity.ok().body(journal.updateTransaction(transaction));
    }*/
}
